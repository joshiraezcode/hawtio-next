import { ResolveUser, userService } from '@hawtiosrc/auth/user-service'
import { hawtio, Logger } from '@hawtiosrc/core'
import { jwtDecode } from 'jwt-decode'
import * as oidc from 'oauth4webapi'
import { AuthorizationResponseError, AuthorizationServer, Client, ClientAuth, OAuth2Error } from 'oauth4webapi'
import { fetchPath } from '@hawtiosrc/util/fetch'
import { getCookie } from '@hawtiosrc/util/https'

const pluginName = 'hawtio-oidc'
const log = Logger.get(pluginName)

const clientAuth: ClientAuth = (_as, client, parameters, _headers) => {
  parameters.set('client_id', client.client_id)
  return Promise.resolve()
}

export type OidcConfig = {
  /** Provider type. If "null", then OIDC is not enabled */
  method: 'oidc' | null

  /** Provider URL. Should be the URL without ".well-known/openid-configuration" */
  provider: string

  /** Unique Client ID for OIDC provider */
  client_id: string

  /** Response mode according to https://openid.net/specs/oauth-v2-multiple-response-types-1_0.html#ResponseModes */
  response_mode: 'query' | 'fragment'

  /** Scope used to obtain relevant access token from OIDC provider */
  scope: string

  /** Redirect URI passed with OIDC authorization request */
  redirect_uri: string

  /** PKCE method for Authorization grant, according to https://datatracker.ietf.org/doc/html/rfc7636#section-4.3 */
  code_challenge_method: 'S256' | 'plain' | null

  /** Prompt type according to https://openid.net/specs/openid-connect-core-1_0.html#AuthRequest */
  prompt: 'none' | 'login' | 'consent' | 'select_account' | null

  'openid-configuration': oidc.AuthorizationServer
}

export interface IOidcService {
  registerUserHooks(helpRegistration: () => void): void
}

class UserInfo {
  user: string | null = null
  access_token: string | null | undefined = null
  refresh_token: string | null | undefined = null
  at_exp: number = 0
}

export class OidcService implements IOidcService {
  // promises created during construction - should be already resolved in fetchUser
  private readonly config: Promise<OidcConfig | null>
  private readonly enabled: Promise<boolean>
  private readonly oidcMetadata: Promise<AuthorizationServer | null>
  private userInfo: Promise<UserInfo | null>
  private originalFetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

  constructor() {
    this.config = fetchPath<OidcConfig | null>('auth/config', {
      success: (data: string) => {
        try {
          return JSON.parse(data)
        } catch {
          return null
        }
      },
      error: () => null,
    })

    this.enabled = this.isOidcEnabled()
    this.oidcMetadata = this.fetchOidcMetadata()
    this.userInfo = this.initialize()
    this.originalFetch = fetch
  }

  private async isOidcEnabled(): Promise<boolean> {
    const cfg = await this.config
    return cfg?.method === 'oidc' && cfg?.provider != null
  }

  private async fetchOidcMetadata(): Promise<AuthorizationServer | null> {
    let res = null
    const enabled = await this.enabled
    const cfg = await this.config
    if (!enabled || !cfg) {
      log.debug('OpenID authorization is disabled')
      return null
    }

    if (cfg['openid-configuration']) {
      // no need to contact .well-known/openid-configuration here - we have what we need from auth/config
      log.info('Using pre-fetched openid-configuration')
      return cfg['openid-configuration']
    } else {
      log.info('Fetching openid-configuration')
      const cfgUrl = new URL(cfg!.provider)
      res = await oidc
        .discoveryRequest(cfgUrl, {
          [oidc.allowInsecureRequests]: true,
        })
        .catch(e => {
          log.error('Failed OIDC discovery request', e)
        })
      if (!res || !res.ok) {
        return null
      }

      return await oidc.processDiscoveryResponse(cfgUrl, res)
    }
  }

  private async initialize(): Promise<UserInfo | null> {
    const config = await this.config
    const enabled = await this.enabled
    const as = await this.oidcMetadata
    if (!config || !enabled || !as) {
      return null
    }

    // we have all the metadata to try to log in to OpenID provider.

    // have we just been redirected with OAuth2 authirization response in query/fragment?
    let urlParams: URLSearchParams | null = null

    if (config!.response_mode === 'fragment') {
      if (window.location.hash && window.location.hash.length > 0) {
        urlParams = new URLSearchParams(window.location.hash.substring(1))
      }
    } else if (config!.response_mode === 'query') {
      if (window.location.search || window.location.search.length > 0) {
        urlParams = new URLSearchParams(window.location.search.substring(1))
      }
    }

    const goodParamsRequired = ['code', 'state']
    const errorParamsRequired = ['error']

    if (as['authorization_response_iss_parameter_supported']) {
      // https://datatracker.ietf.org/doc/html/rfc9207#section-2.3
      goodParamsRequired.push('iss')
    }

    let oauthSuccess = urlParams != null
    let oauthError = false
    if (urlParams != null) {
      goodParamsRequired.forEach(p => {
        oauthSuccess &&= urlParams!.get(p) != null
      })
      errorParamsRequired.forEach(p => {
        oauthError ||= urlParams!.get(p) != null
      })
    }

    if (oauthError) {
      // we are already after redirect, but there was an OAuth2/OpenID problem
      const error: OAuth2Error = {
        error: urlParams?.get('error') as string,
        error_description: urlParams?.get('error_description') as string,
        error_uri: urlParams?.get('error_uri') as string,
      }
      log.error('OpenID Connect error', error)
      return null
    }

    if (!oauthSuccess) {
      // there are no query/fragment params in the URL, so we're logging for the first time
      const code_challenge_method = config!.code_challenge_method
      const code_verifier = oidc.generateRandomCodeVerifier()
      // TODO: - this method calls crypto.subtle.digest('SHA-256', buf(codeVerifier)) so we need secure context
      if (!window.isSecureContext) {
        log.error("Can't perform OpenID Connect authentication in non-secure context")
        return null
      }
      const code_challenge = await oidc.calculatePKCECodeChallenge(code_verifier)

      const state = oidc.generateRandomState()
      const nonce = oidc.generateRandomNonce()

      // put some data to localStorage, so we can verify the OAuth2 response after redirect
      localStorage.removeItem('hawtio-oidc-login')
      localStorage.setItem(
        'hawtio-oidc-login',
        JSON.stringify({
          st: state,
          cv: code_verifier,
          n: nonce,
          h: window.location.href,
        }),
      )
      log.info('Added to local storage', localStorage.getItem('hawtio-oidc-login'))

      const authorizationUrl = new URL(as!.authorization_endpoint!)
      authorizationUrl.searchParams.set('response_type', 'code')
      authorizationUrl.searchParams.set('response_mode', config.response_mode)
      authorizationUrl.searchParams.set('client_id', config.client_id)
      authorizationUrl.searchParams.set('redirect_uri', config.redirect_uri)
      const basePath = hawtio.getBasePath()
      const u = new URL(window.location.href)
      u.hash = ''
      let redirect = u.pathname
      if (basePath && redirect.startsWith(basePath)) {
        redirect = redirect.slice(basePath.length)
        if (redirect.startsWith('/')) {
          redirect = redirect.slice(1)
        }
      }
      // we have to use react-router to do client-redirect to connect/login if necessary
      // and we can't do full redirect to URL that's not configured on OIDC provider
      // and Entra ID can't use redirect_uri with wildcards... (Keycloak can do it)
      sessionStorage.setItem('connect-login-redirect', redirect)
      authorizationUrl.searchParams.set('scope', config.scope)
      if (code_challenge_method) {
        authorizationUrl.searchParams.set('code_challenge_method', code_challenge_method)
        authorizationUrl.searchParams.set('code_challenge', code_challenge)
      }
      authorizationUrl.searchParams.set('state', state)
      authorizationUrl.searchParams.set('nonce', nonce)
      // do not take 'prompt' option, leave the default non-set version, as it works best with Hawtio and redirects

      log.info('Redirecting to ', authorizationUrl)

      // point of no return
      window.location.assign(authorizationUrl)
      // return unresolvable promise to wait for redirect
      return new Promise((_resolve, _reject) => {
        log.debug('Waiting for redirect')
      })
    }

    const client: Client = {
      client_id: config.client_id,
      token_endpoint_auth_method: 'none',
    }

    // there are proper OAuth2/OpenID params, so we can exchange them for access_token, refresh_token and id_token
    const state = urlParams!.get('state')
    let authResponse
    try {
      authResponse = oidc.validateAuthResponse(as, client, urlParams!, state!)
    } catch (e) {
      if (e instanceof AuthorizationResponseError) {
        log.error('OpenID Authorization error', e)
        return null
      }
    }

    log.info('Getting localStore data, because we have params', urlParams)
    const loginDataString = localStorage.getItem('hawtio-oidc-login')
    // localStorage.removeItem("hawtio-oidc-login")
    if (!loginDataString) {
      log.warn("No local data, can't proceed with OpenID authorization grant")
      return null
    }
    const loginData = JSON.parse(loginDataString)
    if (!loginData.cv || !loginData.st) {
      log.warn("Missing local data, can't proceed with OpenID authorization grant")
      return null
    }

    const res = await oidc
      .authorizationCodeGrantRequest(as, client, clientAuth, authResponse!, config.redirect_uri, loginData.cv, {
        [oidc.allowInsecureRequests]: true,
      })
      .catch(e => {
        log.warn('Problem accessing OpenID token endpoint', e)
        return null
      })
    if (!res) {
      log.warn('No authorization code grant response available')
      return null
    }

    const tokenResponse = await oidc
      .processAuthorizationCodeResponse(as, client, res, {
        expectedNonce: loginData.n,
        maxAge: oidc.skipAuthTimeCheck,
      })
      .catch(e => {
        log.warn('Problem processing OpenID token response', e)
        log.error('OpenID Token error', e)
        return null
      })
    if (!tokenResponse) {
      return null
    }

    const access_token = tokenResponse['access_token']
    const refresh_token = tokenResponse['refresh_token']
    let at_exp: number = 0
    // const id_token = tokenResponse["id_token"]

    // we have to parse (though we shouldn't according to MS) access_token to get it's validity
    try {
      const access_token_decoded = jwtDecode(access_token)
      if (access_token_decoded['exp']) {
        at_exp = access_token_decoded['exp']
      } else {
        at_exp = 0
        log.warn('Access token doesn\'t contain "exp" information')
      }
    } catch (e) {
      log.warn('Problem determining access token validity', e)
    }

    const claims = oidc.getValidatedIdTokenClaims(tokenResponse)
    if (!claims) {
      log.warn('No ID token returned')
      return null
    }
    const user = (claims.preferred_username ?? claims.sub) as string

    // clear the URL bar
    window.history.replaceState(null, '', loginData.h)

    this.setupFetch()

    return {
      user,
      access_token,
      refresh_token,
      at_exp,
    }
  }

  private isTokenExpiring(at_exp: number): boolean {
    const now = Math.floor(Date.now() / 1000)
    if (at_exp - 5 < now) {
      // is expired, or will expire within 5 seconds
      return true
    } else {
      return false
    }
  }

  registerUserHooks(helpRegistration: () => void) {
    const fetchUser = async (resolveUser: ResolveUser, proceed?: () => boolean) => {
      if (proceed && !proceed()) {
        return false
      }

      const userInfo = await this.userInfo
      if (!userInfo) {
        return false
      }
      resolveUser({ username: userInfo.user!, isLogin: true })
      userService.setToken(userInfo.access_token!)

      // only now register help tab for OIDC
      helpRegistration()

      return true
    }
    userService.addFetchUserHook('oidc', fetchUser)

    const logout = async () => {
      const md = await this.oidcMetadata
      if (md?.end_session_endpoint) {
        window.location.replace(md?.end_session_endpoint)
        return true
      }
      return false
    }
    userService.addLogoutHook('oidc', logout)
  }

  private async updateToken(success: (userInfo: UserInfo) => void, failure?: () => void) {
    const userInfo = await this.userInfo
    if (!userInfo) {
      return
    }
    if (userInfo.refresh_token) {
      const config = await this.config
      const enabled = await this.enabled
      const as = await this.oidcMetadata
      if (!config || !enabled || !as) {
        return
      }

      const client: Client = {
        client_id: config.client_id,
        token_endpoint_auth_method: 'none',
      }

      // use the original fetch - we don't want stack overflow
      const options: oidc.TokenEndpointRequestOptions = {
        [oidc.customFetch]: this.originalFetch,
        [oidc.allowInsecureRequests]: true,
      }
      const res = await oidc
        .refreshTokenGrantRequest(as, client, clientAuth, userInfo.refresh_token, options)
        .catch(e => {
          log.error('Problem refreshing token', e)
          if (failure) {
            failure()
          }
        })
      if (!res) {
        return
      }
      const refreshResponse = await oidc.processRefreshTokenResponse(as, client, res).catch(e => {
        log.error('Problem processing refresh token response', e)
      })
      if (!refreshResponse) {
        return
      }
      userInfo.access_token = refreshResponse['access_token'] as string
      userInfo.refresh_token = refreshResponse['refresh_token'] as string
      const access_token_decoded = jwtDecode(userInfo.access_token)
      if (access_token_decoded['exp']) {
        userInfo.at_exp = access_token_decoded['exp']
      } else {
        userInfo.at_exp = 0
        log.warn('Access token doesn\'t contain "exp" information')
      }

      this.userInfo = Promise.resolve(userInfo)
      success(userInfo)
    } else {
      log.error('No refresh token available')
    }
  }

  /**
   * Replace global `fetch` function with a delegated call that handles authorization for remote Jolokia agents
   * and target agent that may run as proxy (to remote Jolokia agent)
   * @private
   */
  private async setupFetch() {
    let userInfo = await this.userInfo
    if (!userInfo) {
      return
    }

    log.debug('Intercept Fetch API to attach OIDC token to authorization header')
    const { fetch: originalFetch } = window
    this.originalFetch = originalFetch
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const logPrefix = 'Fetch -'
      log.debug(logPrefix, 'Fetch intercepted for OIDC authentication')

      if (userInfo && (!userInfo.access_token || this.isTokenExpiring(userInfo.at_exp))) {
        log.debug(logPrefix, 'Try to update token for request:', input)
        return new Promise((resolve, reject) => {
          this.updateToken(
            _userInfo => {
              if (_userInfo) {
                userInfo = _userInfo
                log.debug(logPrefix, 'OIDC token refreshed. Set new value to userService')
                userService.setToken(userInfo!.access_token!)
              }
              log.debug(logPrefix, 'Re-sending request after successfully updating OIDC token:', input)
              resolve(fetch(input, init))
            },
            () => {
              log.debug(logPrefix, 'Logging out due to token update failed')
              userService.logout()
              reject()
            },
          )
        })
      }

      init = { ...init }

      init.headers = {
        ...init.headers,
        Authorization: `Bearer ${userInfo!.access_token}`,
      }

      // For CSRF protection with Spring Security
      const token = getCookie('XSRF-TOKEN')
      if (token) {
        log.debug(logPrefix, 'Set XSRF token header from cookies')
        init.headers = {
          ...init.headers,
          'X-XSRF-TOKEN': token,
        }
      }

      return originalFetch(input, init)
    }
  }
}

export const oidcService = new OidcService()
