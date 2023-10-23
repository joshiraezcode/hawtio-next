import { hawtio } from '@hawtiosrc/core'
import { jolokiaService } from '@hawtiosrc/plugins/shared/jolokia-service'
import { escapeMBean } from '@hawtiosrc/util/jolokia'
import { log } from '../globals'

class OperationService {
  async execute(mbean: string, operation: string, args: unknown[]): Promise<unknown> {
    log.debug('Execute:', mbean, '-', operation, '-', args)
    return jolokiaService.execute(mbean, operation, args)
  }

  async getJolokiaUrl(mbean: string, operation: string): Promise<string> {
    const mbeanName = escapeMBean(mbean)
    const basePath = hawtio.getBasePath() ?? ''
    const origin = window.location.origin
    const jolokiaUrl = (await jolokiaService.getJolokiaUrl()) ?? ''
    const jolokiaPath = jolokiaUrl.startsWith('/') ? jolokiaUrl : basePath + jolokiaUrl
    return `${origin}${jolokiaPath}/exec/${mbeanName}/${operation}`
  }
}

export const operationService = new OperationService()
