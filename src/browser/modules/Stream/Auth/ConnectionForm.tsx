/*
 * Copyright (c) 2002-2020 "Neo4j,"
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
  getActiveConnectionData,
  getActiveConnection,
  setActiveConnection,
  updateConnection,
  CONNECT,
  VERIFY_CREDENTIALS,
  isConnected
} from 'shared/modules/connections/connectionsDuck'
import {
  getInitCmd,
  getPlayImplicitInitCommands
} from 'shared/modules/settings/settingsDuck'
import { executeSystemCommand } from 'shared/modules/commands/commandsDuck'
import { shouldRetainConnectionCredentials } from 'shared/modules/dbMeta/dbMetaDuck'
import { FORCE_CHANGE_PASSWORD } from 'shared/modules/cypher/cypherDuck'
import { NATIVE, NO_AUTH } from 'services/bolt/boltHelpers'

import ConnectForm from './ConnectForm'
import ConnectedView from './ConnectedView'
import ChangePasswordForm from './ChangePasswordForm'
import {
  getAllowedAuthSchemes,
  getAllowedBoltSchemes,
  inCloudEnv
} from 'shared/modules/app/appDuck'
import { FOCUS } from 'shared/modules/editor/editorDuck'
import {
  generateBoltUrl,
  getScheme,
  toggleSchemeRouting,
  isNonSupportedRoutingSchemeError
} from 'services/boltscheme.utils'
import { StyledConnectionBody } from './styled'

type ConnectionFormState = any

export class ConnectionForm extends Component<any, ConnectionFormState> {
  constructor(props: any) {
    super(props)
    const connection =
      this.props.activeConnectionData || this.props.frame.connectionData || {}
    const authenticationMethod =
      (connection && connection.authenticationMethod) || NATIVE

    this.state = {
      requestedUseDb: '',
      ...connection,
      host: generateBoltUrl(props.allowedSchemes, connection.host),
      authenticationMethod,
      isLoading: false,
      passwordChangeNeeded: props.passwordChangeNeeded || false,
      forcePasswordChange: props.forcePasswordChange || false,
      successCallback: props.onSuccess || (() => {}),
      used: props.isConnected
    }
  }

  tryConnect = (password: any, doneFn: any) => {
    this.props.error({})
    this.props.bus.self(
      VERIFY_CREDENTIALS,
      { ...this.state, password },
      (res: any) => doneFn(res)
    )
  }

  connect = (
    doneFn = () => {},
    onError: any = null,
    noResetConnectionOnFail = false
  ) => {
    this.props.error({})
    this.props.bus.self(
      CONNECT,
      {
        ...this.state,
        noResetConnectionOnFail
      },
      (res: any) => {
        if (res.success) {
          doneFn()
          this.saveAndStart()
        } else {
          if (
            res.error.code === 'Neo.ClientError.Security.CredentialsExpired'
          ) {
            doneFn()
            this.setState({ passwordChangeNeeded: true })
          } else if (isNonSupportedRoutingSchemeError(res.error)) {
            // Need to switch scheme to bolt:// for Neo4j 3.x connections
            const url = toggleSchemeRouting(this.state.host)
            this.props.error(
              Error(
                `Could not connect with the "${getScheme(
                  this.state.host
                )}://" scheme to this Neoj server. Automatic retry using the "${getScheme(
                  url
                )}://" scheme in a moment...`
              )
            )
            this.setState({ host: url, hostInputVal: url }, () => {
              setTimeout(() => {
                this.connect(doneFn, onError, noResetConnectionOnFail)
              }, 5000)
            })
            return
          } else {
            doneFn()
            if (onError) {
              return onError(res)
            }
            this.props.error(res.error)
          }
        }
      }
    )
  }

  onDatebaseChange = (event: any) => {
    const requestedUseDb = event.target.value
    this.setState({ requestedUseDb })
    this.props.error({})
  }

  onUsernameChange = (event: any) => {
    const username = event.target.value
    this.setState({ username })
    this.props.error({})
  }

  onPasswordChange = (event: any) => {
    const password = event.target.value
    this.setState({ password })
    this.props.error({})
  }

  onAuthenticationMethodChange(event: any) {
    const authenticationMethod = event.target.value
    const username =
      authenticationMethod === NO_AUTH ? '' : this.state.username || 'neo4j'
    const password = authenticationMethod === NO_AUTH ? '' : this.state.password
    this.setState({ authenticationMethod, username, password })
    this.props.error({})
  }

  onHostChange(fallbackScheme: any, val: any) {
    const url = generateBoltUrl(this.props.allowedSchemes, val, fallbackScheme)
    this.setState({
      host: url,
      hostInputVal: url
    })
    this.props.error({})
  }

  onChangePasswordChange() {
    this.props.error({})
  }

  onChangePassword({ newPassword, error }: any) {
    this.setState({ isLoading: true })
    if (error && error.code) {
      this.setState({ isLoading: false })
      return this.props.error(error)
    }
    if (this.state.password === null) {
      this.setState({ isLoading: false })
      return this.props.error({ message: 'Please set existing password' })
    }
    this.props.error({})
    this.props.bus.self(
      FORCE_CHANGE_PASSWORD,
      {
        host: this.state.host,
        username: this.state.username,
        password: this.state.password,
        newPassword
      },
      (response: any) => {
        if (response.success) {
          return this.setState({ password: newPassword }, () => {
            let retries = 5
            const retryFn = (res: any) => {
              // New password not accepted yet, initiate retry
              if (res.error.code === 'Neo.ClientError.Security.Unauthorized') {
                retries--
                if (retries > 0) {
                  setTimeout(
                    () =>
                      this.connect(
                        () => {
                          this.setState({ isLoading: false })
                        },
                        retryFn,
                        true
                      ),
                    200
                  )
                }
              } else {
                this.props.error(res.error)
              }
            }
            this.connect(
              () => {
                this.setState({ isLoading: false })
              },
              retryFn,
              true
            )
          })
        }
        this.setState({ isLoading: false })
        this.props.error(response.error)
      }
    )
  }

  saveAndStart() {
    this.setState({ forcePasswordChange: false, used: true })
    this.state.successCallback()
    this.props.bus && this.props.bus.send(FOCUS)
    this.saveCredentials()
    this.props.setActiveConnection(this.state.id)
    if (this.props.playImplicitInitCommands) {
      this.props.executeInitCmd()
    }
  }

  saveCredentials() {
    this.props.updateConnection({
      id: this.state.id,
      host: this.state.host,
      username: this.state.username,
      password: this.state.password,
      authenticationMethod: this.state.authenticationMethod
    })
  }

  render() {
    let view
    if (
      this.state.forcePasswordChange ||
      (!this.props.isConnected && this.state.passwordChangeNeeded)
    ) {
      view = (
        <ChangePasswordForm
          showExistingPasswordInput={this.props.showExistingPasswordInput}
          onChangePasswordClick={this.onChangePassword.bind(this)}
          onChange={this.onChangePasswordChange.bind(this)}
          tryConnect={(password: any, doneFn: any) => {
            this.setState({ isLoading: true }, () =>
              this.tryConnect(password, doneFn)
            )
          }}
          isLoading={this.state.isLoading}
        >
          {this.props.children}
        </ChangePasswordForm>
      )
    } else if (
      this.props.isConnected &&
      this.props.activeConnectionData &&
      this.props.activeConnectionData.authEnabled !== false // falsy value indicates (except false) we don't know yet, so see that as enabled.
    ) {
      view = (
        <ConnectedView
          host={this.state.host}
          username={this.props.activeConnectionData.username}
          storeCredentials={this.props.storeCredentials}
          hideStoreCredentials={this.state.authenticationMethod === NO_AUTH}
        />
      )
    } else if (
      this.props.isConnected &&
      this.props.activeConnectionData &&
      this.props.activeConnectionData.authEnabled === false // explicit false = auth disabled for sure
    ) {
      view = (
        <StyledConnectionBody>
          You have a working connection and server auth is disabled.
        </StyledConnectionBody>
      )
    } else if (!this.props.isConnected && !this.state.passwordChangeNeeded) {
      view = (
        <ConnectForm
          onConnectClick={this.connect.bind(this)}
          onHostChange={this.onHostChange.bind(this)}
          onUsernameChange={this.onUsernameChange}
          onPasswordChange={this.onPasswordChange}
          onDatabaseChange={this.onDatebaseChange}
          onAuthenticationMethodChange={this.onAuthenticationMethodChange.bind(
            this
          )}
          host={this.state.hostInputVal || this.state.host}
          username={this.state.username}
          password={this.state.password}
          database={this.state.requestedUseDb}
          supportsMultiDb={this.state.supportsMultiDb}
          used={this.state.used}
          allowedSchemes={this.props.allowedSchemes}
          allowedAuthMethods={this.props.allowedAuthMethods}
          authenticationMethod={this.state.authenticationMethod}
        />
      )
    }
    return view
  }
}

const mapStateToProps = (state: any) => {
  return {
    initCmd: getInitCmd(state),
    activeConnection: getActiveConnection(state),
    activeConnectionData: getActiveConnectionData(state),
    playImplicitInitCommands: getPlayImplicitInitCommands(state),
    storeCredentials: shouldRetainConnectionCredentials(state),
    isConnected: isConnected(state),
    allowedSchemes: getAllowedBoltSchemes(state),
    allowedAuthMethods: getAllowedAuthSchemes(state)
  }
}

const mapDispatchToProps = (dispatch: any) => {
  return {
    updateConnection: (connection: any) => {
      dispatch(updateConnection(connection))
    },
    setActiveConnection: (id: any) => dispatch(setActiveConnection(id)),
    dispatchInitCmd: (initCmd: any) => dispatch(executeSystemCommand(initCmd))
  }
}

const mergeProps = (stateProps: any, dispatchProps: any, ownProps: any) => {
  return {
    playImplicitInitCommands: stateProps.playImplicitInitCommands,
    activeConnection: stateProps.activeConnection,
    activeConnectionData: stateProps.activeConnectionData,
    storeCredentials: stateProps.storeCredentials,
    isConnected: stateProps.isConnected,
    allowedSchemes: stateProps.allowedSchemes,
    allowedAuthMethods: stateProps.allowedAuthMethods,
    ...ownProps,
    ...dispatchProps,
    executeInitCmd: () => {
      dispatchProps.dispatchInitCmd(stateProps.initCmd)
    }
  }
}

export default withBus(
  connect(mapStateToProps, mapDispatchToProps, mergeProps)(ConnectionForm)
)
