import { Nav, NavItem, NavList, PageGroup, PageNavigation, PageSection, Title } from '@patternfly/react-core'
import React, { useEffect, useState } from 'react'

import { Navigate, NavLink, Route, Routes, useLocation } from 'react-router-dom'
import { Health } from '@hawtiosrc/plugins/springboot/Health'
import { Info } from '@hawtiosrc/plugins/springboot/Info'
import { Loggers } from '@hawtiosrc/plugins/springboot/Loggers'
import { TraceView } from '@hawtiosrc/plugins/springboot/TraceView'
import { springbootService } from '@hawtiosrc/plugins/springboot/springboot-service'

type NavItem = {
  id: string
  title: string
  component: JSX.Element
}
export const SpringBoot: React.FunctionComponent = () => {
  const location = useLocation()
  const [navItems, setNavItems] = useState<NavItem[]>([])

  useEffect(() => {
    const initNavItems = async () => {
      const nav: NavItem[] = []
      if (await springbootService.hasEndpoint('Health')) {
        nav.push({ id: 'health', title: 'Health', component: <Health /> })
      }

      if (await springbootService.hasEndpoint('Info')) {
        nav.push({ id: 'info', title: 'Info', component: <Info /> })
      }

      if (await springbootService.hasEndpoint('Loggers')) {
        nav.push({ id: 'loggers', title: 'Loggers', component: <Loggers /> })
      }

      if (await springbootService.hasEndpoint('Httptrace')) {
        springbootService.setisSb3(false)
        nav.push({ id: 'trace', title: 'Trace', component: <TraceView /> })
      }

      if (await springbootService.hasEndpoint('Httpexchanges')) {
        springbootService.setisSb3(true)
        nav.push({ id: 'trace', title: 'Trace', component: <TraceView /> })
      }

      setNavItems([...nav])
    }
    initNavItems()
  }, [])

  return (
    <React.Fragment>
      <PageSection variant='light'>
        <Title headingLevel='h1'>Spring Boot</Title>
      </PageSection>
      <PageGroup>
        <PageNavigation>
          <Nav aria-label='Spring-boot Nav' variant='tertiary'>
            <NavList>
              {navItems.map(navItem => (
                <NavItem key={navItem.id} isActive={location.pathname === `/springboot/${navItem.id}`}>
                  <NavLink to={navItem.id}>{navItem.title}</NavLink>
                </NavItem>
              ))}
            </NavList>
          </Nav>
        </PageNavigation>
      </PageGroup>
      <PageSection>
        <Routes>
          {navItems.map(navItem => (
            <Route key={navItem.id} path={navItem.id} element={navItem.component} />
          ))}
          <Route path='/' element={<Navigate to='health' />} />
        </Routes>
      </PageSection>
    </React.Fragment>
  )
}
