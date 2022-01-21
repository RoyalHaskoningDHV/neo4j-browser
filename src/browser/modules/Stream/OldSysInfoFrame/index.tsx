/*
 * Copyright (c) "Neo4j"
 * Neo4j Sweden AB [http://neo4j.com]
 *
 * This file is part of Neo4j.
 *
 * Neo4j is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */
import React, { Component } from 'react'
import { connect } from 'react-redux'
import { withBus } from 'react-suber'

import {
  AutoRefreshSpan,
  AutoRefreshToggle,
  StatusbarWrapper,
  StyledStatusBar
} from '../AutoRefresh/styled'
import { ErrorsView } from '../CypherFrame/ErrorsView'
import * as helpers from './helpers'
import * as legacyHelpers from './legacyHelpers'
import Render from 'browser-components/Render'
import FrameError from 'browser/modules/Frame/FrameError'
import FrameTemplate from 'browser/modules/Frame/FrameTemplate'
import { NEO4J_BROWSER_USER_ACTION_QUERY } from 'services/bolt/txMetadata'
import {
  getUseDb,
  isConnected
} from 'shared/modules/connections/connectionsDuck'
import { CYPHER_REQUEST } from 'shared/modules/cypher/cypherDuck'
import { isEnterprise } from 'shared/modules/dbMeta/dbMetaDuck'
import { getDatabases } from 'shared/modules/dbMeta/dbMetaDuck'
import { isACausalCluster } from 'shared/modules/features/featuresDuck'
import { hasMultiDbSupport } from 'shared/modules/features/versionedFeatures'

type SysInfoFrameState = any

export class SysInfoFrame extends Component<any, SysInfoFrameState> {
  helpers: any
  timer: any
  constructor(props: {}) {
    super(props)
    this.state = {
      lastFetch: null,
      cc: [],
      ha: [],
      haInstances: [],
      storeSizes: [],
      idAllocation: [],
      pageCache: [],
      transactions: [],
      error: '',
      results: false,
      success: null,
      autoRefresh: false,
      autoRefreshInterval: 20 // seconds
    }
    this.helpers = this.props.hasMultiDbSupport ? helpers : legacyHelpers
  }

  componentDidMount() {
    this.getSysInfo()
  }

  componentDidUpdate(prevProps: any, prevState: SysInfoFrameState) {
    if (prevState.autoRefresh !== this.state.autoRefresh) {
      if (this.state.autoRefresh) {
        this.timer = setInterval(
          this.getSysInfo.bind(this),
          this.state.autoRefreshInterval * 1000
        )
      } else {
        clearInterval(this.timer)
      }
    }
    if (
      this.props.frame &&
      this.props.frame.ts !== prevProps.frame.ts &&
      this.props.frame.isRerun
    ) {
      this.getSysInfo()
    }
  }

  getSysInfo() {
    if (this.props.bus && this.props.isConnected) {
      this.setState({ lastFetch: Date.now() })
      this.props.bus.self(
        CYPHER_REQUEST,
        {
          query: this.helpers.sysinfoQuery(this.props.useDb),
          queryType: NEO4J_BROWSER_USER_ACTION_QUERY
        },
        this.helpers.responseHandler(this.setState.bind(this), this.props.useDb)
      )
      if (this.props.isACausalCluster) {
        this.props.bus.self(
          CYPHER_REQUEST,
          {
            query: 'CALL dbms.cluster.overview',
            queryType: NEO4J_BROWSER_USER_ACTION_QUERY
          },
          this.helpers.clusterResponseHandler(this.setState.bind(this))
        )
      }
    } else {
      this.setState({ error: 'No connection available' })
    }
  }

  setAutoRefresh(autoRefresh: any) {
    this.setState({ autoRefresh: autoRefresh })

    if (autoRefresh) {
      this.getSysInfo()
    }
  }

  render() {
    const SysinfoComponent = this.helpers.Sysinfo
    const content = !this.props.isConnected ? (
      <ErrorsView
        result={{ code: 'No connection', message: 'No connection available' }}
      />
    ) : (
      <SysinfoComponent
        {...this.state}
        databases={this.props.databases}
        isACausalCluster={this.props.isACausalCluster}
        isEnterpriseEdition={this.props.isEnterprise}
        useDb={this.props.useDb}
      />
    )

    return (
      <FrameTemplate
        header={this.props.frame}
        contents={content}
        statusbar={
          <StatusbarWrapper>
            <Render if={this.state.error}>
              <FrameError message={this.state.error} />
            </Render>
            <Render if={this.state.success}>
              <StyledStatusBar>
                {this.state.lastFetch &&
                  `Updated: ${new Date(this.state.lastFetch).toISOString()}`}
                {this.state.success}
                <AutoRefreshSpan>
                  <AutoRefreshToggle
                    checked={this.state.autoRefresh}
                    onChange={(e: any) => this.setAutoRefresh(e.target.checked)}
                  />
                </AutoRefreshSpan>
              </StyledStatusBar>
            </Render>
          </StatusbarWrapper>
        }
      />
    )
  }
}

const mapStateToProps = (state: any) => {
  return {
    hasMultiDbSupport: hasMultiDbSupport(state),
    isACausalCluster: isACausalCluster(state),
    isEnterprise: isEnterprise(state),
    isConnected: isConnected(state),
    databases: getDatabases(state),
    useDb: getUseDb(state)
  }
}

export default withBus(connect(mapStateToProps)(SysInfoFrame))
