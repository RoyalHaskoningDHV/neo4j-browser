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

import neo4j from 'neo4j-driver'
import Rx from 'rxjs/Rx'
import bolt from 'services/bolt/bolt'
import { isConfigValFalsy } from 'services/bolt/boltHelpers'
import { APP_START } from 'shared/modules/app/appDuck'
import {
  CONNECTED_STATE,
  CONNECTION_SUCCESS,
  connectionLossFilter,
  DISCONNECTION_SUCCESS,
  LOST_CONNECTION,
  UPDATE_CONNECTION_STATE,
  setRetainCredentials,
  setAuthEnabled,
  onLostConnection,
  getUseDb,
  useDb,
  getActiveConnectionData,
  updateConnection
} from 'shared/modules/connections/connectionsDuck'
import {
  commandSources,
  executeCommand
} from 'shared/modules/commands/commandsDuck'
import { shouldUseCypherThread } from 'shared/modules/settings/settingsDuck'
import { getBackgroundTxMetadata } from 'shared/services/bolt/txMetadata'
import {
  canSendTxMetadata,
  getDbClusterRole
} from '../features/versionedFeatures'
import { extractServerInfo } from './dbMeta.utils'
import { assign, reduce } from 'lodash-es'
import {
  hasClientConfig,
  updateUserCapability,
  USER_CAPABILITIES,
  FEATURE_DETECTION_DONE,
  isACausalCluster,
  setClientConfig
} from '../features/featuresDuck'

export const NAME = 'meta'
export const UPDATE = 'meta/UPDATE'
export const UPDATE_META = 'meta/UPDATE_META'
export const UPDATE_SERVER = 'meta/UPDATE_SERVER'
export const FETCH_SERVER_INFO = 'meta/FETCH_SERVER_INFO'
export const UPDATE_SETTINGS = 'meta/UPDATE_SETTINGS'
export const CLEAR = 'meta/CLEAR'
export const FORCE_FETCH = 'meta/FORCE_FETCH'
export const DB_META_DONE = 'meta/DB_META_DONE'

export const SYSTEM_DB = 'system'

/**
 * Selectors
 */
export function getMetaInContext(state: any, context: any) {
  const inCurrentContext = (e: any) => e.context === context

  const labels = state.labels.filter(inCurrentContext)
  const relationshipTypes = state.relationshipTypes.filter(inCurrentContext)
  const properties = state.properties.filter(inCurrentContext)
  const functions = state.functions.filter(inCurrentContext)
  const procedures = state.procedures.filter(inCurrentContext)

  return {
    labels,
    relationshipTypes,
    properties,
    functions,
    procedures
  }
}

export const getVersion = (state: any) =>
  (state[NAME] || {}).server ? (state[NAME] || {}).server.version : 0
export const getEdition = (state: any) => state[NAME].server.edition
export const getStoreSize = (state: any) => state[NAME].server.storeSize
export const getClusterRole = (state: any) => state[NAME].role
export const isEnterprise = (state: any) =>
  ['enterprise', 'auraenterprise'].includes(state[NAME].server.edition)
export const isBeta = (state: any) => /-/.test(state[NAME].server.version)
export const getStoreId = (state: any) =>
  state[NAME] && state[NAME].server ? state[NAME].server.storeId : null

export const getAvailableSettings = (state: any) =>
  (state[NAME] || initialState).settings
export const allowOutgoingConnections = (state: any) =>
  getAvailableSettings(state)['browser.allow_outgoing_connections']
export const credentialsTimeout = (state: any) =>
  getAvailableSettings(state)['browser.credential_timeout'] || 0
export const getRemoteContentHostnameAllowlist = (state: any) =>
  getAvailableSettings(state)['browser.remote_content_hostname_allowlist']
export const getDefaultRemoteContentHostnameAllowlist = (_state: any) =>
  initialState.settings['browser.remote_content_hostname_allowlist']
export const shouldRetainConnectionCredentials = (state: any) => {
  const settings = getAvailableSettings(state)
  const conf = settings['browser.retain_connection_credentials']
  if (conf === null || typeof conf === 'undefined') return false
  return !isConfigValFalsy(conf)
}
export const getDatabases = (state: any) =>
  (state[NAME] || initialState).databases
export const getActiveDbName = (state: any) =>
  ((state[NAME] || {}).settings || {})['dbms.active_database']
/**
 * Helpers
 */

function updateMetaForContext(state: any, meta: any, context: any) {
  if (!meta || !meta.records || !meta.records.length) {
    return {
      labels: initialState.labels,
      relationshipTypes: initialState.relationshipTypes,
      properties: initialState.properties,
      functions: initialState.functions,
      procedures: initialState.procedures,
      nodes: initialState.nodes,
      relationships: initialState.relationships
    }
  }
  const notInCurrentContext = (e: any) => e.context !== context
  const mapResult = (metaIndex: any, mapFunction: any) =>
    meta.records[metaIndex].get(0).data.map(mapFunction)
  const mapSingleValue = (r: any) => ({
    val: r,
    context
  })
  const mapInteger = (r: any) => (neo4j.isInt(r) ? r.toNumber() || 0 : r || 0)
  const mapInvocableValue = (r: any) => {
    const { name, signature, description } = r
    return {
      val: name,
      context,
      signature,
      description
    }
  }

  const compareMetaItems = (a: any, b: any) =>
    a.val < b.val ? -1 : a.val > b.val ? 1 : 0

  const labels = state.labels
    .filter(notInCurrentContext)
    .concat(mapResult(0, mapSingleValue))
    .sort(compareMetaItems)
  const relationshipTypes = state.relationshipTypes
    .filter(notInCurrentContext)
    .concat(mapResult(1, mapSingleValue))
    .sort(compareMetaItems)
  const properties = state.properties
    .filter(notInCurrentContext)
    .concat(mapResult(2, mapSingleValue))
    .sort(compareMetaItems)
  const functions = state.functions
    .filter(notInCurrentContext)
    .concat(mapResult(3, mapInvocableValue))
  const procedures = state.procedures
    .filter(notInCurrentContext)
    .concat(mapResult(4, mapInvocableValue))
  const nodes = meta.records[5]
    ? mapInteger(meta.records[5].get(0).data)
    : state.nodes
  const relationships = meta.records[6]
    ? mapInteger(meta.records[6].get(0).data)
    : state.relationships

  return {
    labels,
    relationshipTypes,
    properties,
    functions,
    procedures,
    nodes,
    relationships
  }
}

// Initial state
const initialState = {
  nodes: 0,
  relationships: 0,
  labels: [],
  relationshipTypes: [],
  properties: [],
  functions: [],
  procedures: [],
  role: null,
  server: {
    version: null,
    edition: null,
    storeSize: null
  },
  databases: [],
  settings: {
    'browser.allow_outgoing_connections': false,
    'browser.remote_content_hostname_allowlist': 'guides.neo4j.com, localhost',
    'browser.retain_connection_credentials': false
  }
}

/**
 * Reducer
 */
export default function meta(state = initialState, unalteredAction: any) {
  let action = unalteredAction
  if (unalteredAction && unalteredAction.settings) {
    const allowlist =
      unalteredAction.settings['browser.remote_content_hostname_allowlist'] ||
      unalteredAction.settings['browser.remote_content_hostname_whitelist']

    action = allowlist
      ? {
          ...unalteredAction,
          settings: {
            ...unalteredAction.settings,
            ['browser.remote_content_hostname_allowlist']: allowlist
          }
        }
      : unalteredAction
    delete action.settings['browser.remote_content_hostname_whitelist']
  }

  switch (action.type) {
    case APP_START:
      return { ...initialState, ...state }
    case UPDATE:
      const { type, ...rest } = action
      return { ...state, ...rest }
    case UPDATE_META:
      return {
        ...state,
        ...updateMetaForContext(state, action.meta, action.context)
      }
    case UPDATE_SERVER:
      const { type: serverType, ...serverRest } = action
      const serverState: any = {}
      Object.keys(serverRest).forEach(key => {
        serverState[key] = action[key]
      })
      return {
        ...state,
        server: { ...state.server, ...serverState }
      }
    case UPDATE_SETTINGS:
      return { ...state, settings: { ...action.settings } }
    case CLEAR:
      return { ...initialState }
    default:
      return state
  }
}

// Actions
export function updateMeta(meta: any, context?: any) {
  return {
    type: UPDATE_META,
    meta,
    context
  }
}
export function fetchMetaData() {
  return {
    type: FORCE_FETCH
  }
}
export function fetchServerInfo() {
  return {
    type: FETCH_SERVER_INFO
  }
}

export const update = (obj: any) => {
  return {
    type: UPDATE,
    ...obj
  }
}

export const updateSettings = (settings: any) => {
  return {
    type: UPDATE_SETTINGS,
    settings
  }
}

export const updateServerInfo = (res: any) => {
  const extrated = extractServerInfo(res)
  return {
    ...extrated,
    type: UPDATE_SERVER
  }
}

// Epics
export const metaQuery = `
CALL db.labels() YIELD label
RETURN {name:'labels', data:COLLECT(label)[..1000]} AS result
UNION ALL
CALL db.relationshipTypes() YIELD relationshipType
RETURN {name:'relationshipTypes', data:COLLECT(relationshipType)[..1000]} AS result
UNION ALL
CALL db.propertyKeys() YIELD propertyKey
RETURN {name:'propertyKeys', data:COLLECT(propertyKey)[..1000]} AS result
UNION ALL
CALL dbms.functions() YIELD name, signature, description
RETURN {name:'functions', data: collect({name: name, signature: signature, description: description})} AS result
UNION ALL
CALL dbms.procedures() YIELD name, signature, description
RETURN {name:'procedures', data:collect({name: name, signature: signature, description: description})} AS result
UNION ALL
MATCH () RETURN { name:'nodes', data:count(*) } AS result
UNION ALL
MATCH ()-[]->() RETURN { name:'relationships', data: count(*)} AS result
`
export const serverInfoQuery =
  'CALL dbms.components() YIELD name, versions, edition'

const databaseList = (store: any) =>
  Rx.Observable.fromPromise(
    new Promise(async (resolve, reject) => {
      const supportsMultiDb = await bolt.hasMultiDbSupport()
      if (!supportsMultiDb) {
        return resolve(null)
      }
      bolt
        .directTransaction(
          'SHOW DATABASES',
          {},
          {
            useCypherThread: shouldUseCypherThread(store.getState()),
            ...getBackgroundTxMetadata({
              hasServerSupport: canSendTxMetadata(store.getState())
            }),
            useDb: SYSTEM_DB
          }
        )
        .then(resolve)
        .catch(reject)
    })
  )
    .catch(() => {
      return Rx.Observable.of(null)
    })
    .do((res: any) => {
      if (!res) return Rx.Observable.of(null)
      const databases = res.records.map((record: any) => ({
        ...reduce(
          record.keys,
          (agg, key) => assign(agg, { [key]: record.get(key) }),
          {}
        ),

        status: record.get('currentStatus')
      }))

      store.dispatch(update({ databases }))

      return Rx.Observable.of(null)
    })

const getLabelsAndTypes = (store: any) =>
  Rx.Observable.of(null).mergeMap(() => {
    const db = getUseDb(store.getState())

    // System db, do nothing
    if (db === SYSTEM_DB) {
      store.dispatch(updateMeta([]))
      return Rx.Observable.of(null)
    }
    // Not system db, try and fetch meta data
    return Rx.Observable.fromPromise(
      bolt.routedReadTransaction(
        metaQuery,
        {},
        {
          useCypherThread: shouldUseCypherThread(store.getState()),
          onLostConnection: onLostConnection(store.dispatch),
          ...getBackgroundTxMetadata({
            hasServerSupport: canSendTxMetadata(store.getState())
          })
        }
      )
    )
      .do(res => {
        if (res) {
          store.dispatch(updateMeta(res))
        }
        return Rx.Observable.of(null)
      })
      .catch(() => {
        store.dispatch(updateMeta([]))
        return Rx.Observable.of(null)
      })
  })

const clusterRole = (store: any) =>
  Rx.Observable.fromPromise(
    new Promise((resolve, reject) => {
      if (!isACausalCluster(store.getState())) {
        return resolve(null)
      }
      bolt
        .directTransaction(
          getDbClusterRole(store.getState()),
          {},
          {
            useCypherThread: shouldUseCypherThread(store.getState()),
            ...getBackgroundTxMetadata({
              hasServerSupport: canSendTxMetadata(store.getState())
            })
          }
        )
        .then(resolve)
        .catch(reject)
    })
  )
    .catch(() => {
      return Rx.Observable.of(null)
    })
    .do((res: any) => {
      if (!res) return Rx.Observable.of(null)
      const role = res.records[0].get(0)
      store.dispatch(update({ role }))
      return Rx.Observable.of(null)
    })

const switchToRequestedDb = (store: any) => {
  if (getUseDb(store.getState())) return Rx.Observable.of(null)

  const databases = getDatabases(store.getState())
  const activeConnection = getActiveConnectionData(store.getState())
  const requestedUseDb = activeConnection?.requestedUseDb

  const useDefaultDb = () => {
    const defaultDb = databases.find((db: any) => db.default)
    if (defaultDb) {
      store.dispatch(useDb(defaultDb.name))
    }
  }

  if (requestedUseDb) {
    const wantedDb = databases.find(
      ({ name }: any) => name.toLowerCase() === requestedUseDb.toLowerCase()
    )
    store.dispatch(
      updateConnection({
        id: activeConnection.id,
        requestedUseDb: ''
      })
    )
    if (wantedDb) {
      store.dispatch(useDb(wantedDb.name))
      // update labels and such for new db
      return getLabelsAndTypes(store)
    } else {
      // this will show the db not found frame
      store.dispatch(executeCommand(`:use ${requestedUseDb}`), {
        source: commandSources.auto
      })
      useDefaultDb()
    }
  } else {
    useDefaultDb()
  }
  return Rx.Observable.of(null)
}

export const dbMetaEpic = (some$: any, store: any) =>
  some$
    .ofType(UPDATE_CONNECTION_STATE)
    .filter((s: any) => s.state === CONNECTED_STATE)
    .merge(some$.ofType(CONNECTION_SUCCESS))
    .mergeMap(() => {
      return (
        Rx.Observable.timer(1, 20000)
          .merge(some$.ofType(FORCE_FETCH))
          // Throw away newly initiated calls until done
          .throttle(() => some$.ofType(DB_META_DONE))
          // Server version and edition
          .do(store.dispatch({ type: FETCH_SERVER_INFO }))
          .mergeMap(() => {
            return Rx.Observable.forkJoin([
              getLabelsAndTypes(store),
              clusterRole(store),
              databaseList(store)
            ])
          })
          .takeUntil(
            some$
              .ofType(LOST_CONNECTION)
              .filter(connectionLossFilter)
              .merge(some$.ofType(DISCONNECTION_SUCCESS))
          )
          .mergeMap(() => switchToRequestedDb(store))
          .mapTo({ type: DB_META_DONE })
      )
    })

export const serverConfigEpic = (some$: any, store: any) =>
  some$
    .ofType(FEATURE_DETECTION_DONE)
    .merge(some$.ofType(DB_META_DONE))
    .mergeMap(() => {
      // Server configuration
      return Rx.Observable.fromPromise(
        new Promise(async (resolve, reject) => {
          const supportsMultiDb = await bolt.hasMultiDbSupport()
          bolt
            .directTransaction(
              `CALL ${
                hasClientConfig(store.getState()) !== false
                  ? 'dbms.clientConfig()'
                  : 'dbms.listConfig()'
              }`,
              {},
              {
                useDb: supportsMultiDb ? SYSTEM_DB : '',
                useCypherThread: shouldUseCypherThread(store.getState()),
                ...getBackgroundTxMetadata({
                  hasServerSupport: canSendTxMetadata(store.getState())
                })
              }
            )
            .then((r: any) => {
              // This is not set yet
              if (hasClientConfig(store.getState()) === null) {
                store.dispatch(setClientConfig(true))
              }
              resolve(r)
            })
            .catch((e: any) => {
              // Try older procedure if the new one doesn't exist
              if (e.code === 'Neo.ClientError.Procedure.ProcedureNotFound') {
                // Store that dbms.clientConfig isn't available
                store.dispatch(setClientConfig(false))

                bolt
                  .directTransaction(
                    `CALL dbms.listConfig()`,
                    {},
                    {
                      useDb: supportsMultiDb ? SYSTEM_DB : '',
                      useCypherThread: shouldUseCypherThread(store.getState()),
                      ...getBackgroundTxMetadata({
                        hasServerSupport: canSendTxMetadata(store.getState())
                      })
                    }
                  )
                  .then(resolve)
                  .catch(reject)
              } else {
                reject(e)
              }
            })
        })
      )
        .catch(() => {
          store.dispatch(
            updateUserCapability(USER_CAPABILITIES.serverConfigReadable, false)
          )
          return Rx.Observable.of(null)
        })
        .do((res: any) => {
          if (!res) return Rx.Observable.of(null)
          const settings = res.records.reduce((all: any, record: any) => {
            const name = record.get('name')
            let value = record.get('value')
            if (name === 'browser.retain_connection_credentials') {
              let retainCredentials = true
              // Check if we should wipe user creds from localstorage
              if (typeof value !== 'undefined' && isConfigValFalsy(value)) {
                retainCredentials = false
              }
              store.dispatch(setRetainCredentials(retainCredentials))
              value = retainCredentials
            } else if (name === 'browser.allow_outgoing_connections') {
              // Use isConfigValFalsy to cast undefined to true
              value = !isConfigValFalsy(value)
            } else if (name === 'dbms.security.auth_enabled') {
              let authEnabled = true
              if (typeof value !== 'undefined' && isConfigValFalsy(value)) {
                authEnabled = false
              }
              value = authEnabled
              store.dispatch(setAuthEnabled(authEnabled))
            }
            all[name] = value
            return all
          }, {})
          store.dispatch(
            updateUserCapability(USER_CAPABILITIES.serverConfigReadable, true)
          )
          store.dispatch(updateSettings(settings))
          return Rx.Observable.of(null)
        })
    })
    .mapTo({ type: 'SERVER_CONFIG_DONE' })

export const serverInfoEpic = (some$: any, store: any) =>
  some$
    .ofType(FETCH_SERVER_INFO)
    .mergeMap(() => {
      const state = store.getState()
      const db = getUseDb(state)
      const query = db === SYSTEM_DB ? 'SHOW DATABASES' : serverInfoQuery
      return Rx.Observable.fromPromise(
        bolt.directTransaction(
          query,
          {},
          {
            useCypherThread: shouldUseCypherThread(store.getState()),
            ...getBackgroundTxMetadata({
              hasServerSupport: canSendTxMetadata(store.getState())
            })
          }
        )
      )
        .catch(() => {
          return Rx.Observable.of(null)
        })
        .do(res => {
          if (!res) return Rx.Observable.of(null)

          store.dispatch(updateServerInfo(res))
          return Rx.Observable.of(null)
        })
    })
    .mapTo({ type: 'NOOP' })

export const clearMetaOnDisconnectEpic = (some$: any, _store: any) =>
  some$.ofType(DISCONNECTION_SUCCESS).mapTo({ type: CLEAR })
