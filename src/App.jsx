import { useEffect, useMemo, useRef, useState } from 'react'
import {
  FaChevronDown,
  FaChevronUp,
  FaCopy,
  FaDownload,
  FaEye,
  FaEyeSlash,
  FaFileExcel,
  FaFileImport,
  FaPlus,
  FaPen,
  FaRightFromBracket,
  FaRotateLeft,
  FaTrash,
} from 'react-icons/fa6'
import { Tooltip } from '@mui/material'
import { DataGrid } from '@mui/x-data-grid'
import * as XLSX from 'xlsx'
import './App.css'

const initialForm = {
  id: '',
  group: '',
  name: '',
  environment: 'DEV',
  host: '',
  port: '',
  username: '',
  password: '',
  database: '',
  memo: '',
}

const initialFilters = {
  group: '',
  name: '',
  environment: '',
  host: '',
  database: '',
  excludeGroup: '',
  excludeName: '',
  excludeEnvironment: '',
  excludeHost: '',
  excludeDatabase: '',
}

const ENCRYPTED_PREFIX = 'enc$'
const PBKDF2_ITERATIONS = 210000
const REVEAL_MS = 10000
const COPY_REVEAL_MS = 5000
const MASTER_KEY_MIN_LENGTH = 7
const MASTER_KEY_ALLOWED_REGEX = /^[A-Za-z0-9!@#$%^&*()_+\-=[\]{};':",.<>/?\\|~]+$/
const MASTER_KEY_LETTER_REGEX = /[A-Za-z]/
const MASTER_KEY_DIGIT_REGEX = /[0-9]/
const MASTER_KEY_SPECIAL_REGEX = /[!@#$%^&*()_+\-=[\]{};':",.<>/?\\|~]/
const EXPORT_FORMAT = 'sam-export-v1'
const STORAGE_FORMAT = 'sam-storage-v1'
const CLIENT_DATA_FILE = 'server-access-items.json'
const LEGACY_CLIENT_DATA_DIR = 'data'
const CLIENT_BACKUP_FILE_PREFIX = 'server-access-backup'
const CLIENT_FS_DB_NAME = 'server-access-manager-fs'
const CLIENT_FS_DB_STORE = 'handles'
const CLIENT_FS_DB_KEY = 'root-dir-handle'
const CLIENT_STORAGE_FALLBACK_KEY = 'server-access-items.local-storage'
const encoder = new TextEncoder()
const decoder = new TextDecoder()
const APP_VERSION = __APP_VERSION__

function bytesToBase64(bytes) {
  let bin = ''
  bytes.forEach((byte) => {
    bin += String.fromCharCode(byte)
  })
  return btoa(bin)
}

function base64ToBytes(base64) {
  const bin = atob(base64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i += 1) {
    bytes[i] = bin.charCodeAt(i)
  }
  return bytes
}

function isEncryptedPassword(value) {
  return typeof value === 'string' && value.startsWith(ENCRYPTED_PREFIX)
}

function isWebUrl(value) {
  if (typeof value !== 'string') return false
  const trimmed = value.trim()
  return /^https?:\/\//i.test(trimmed)
}

async function deriveAesKey(passphrase, saltBytes) {
  const baseKey = await crypto.subtle.importKey(
    'raw',
    encoder.encode(passphrase),
    'PBKDF2',
    false,
    ['deriveKey'],
  )

  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: saltBytes,
      iterations: PBKDF2_ITERATIONS,
      hash: 'SHA-256',
    },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

async function encryptText(plainText, secret, context = '') {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const keySource = context ? `${secret}:${context}` : secret
  const key = await deriveAesKey(keySource, salt)
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    encoder.encode(plainText),
  )

  const payload = {
    v: 1,
    c: context,
    s: bytesToBase64(salt),
    i: bytesToBase64(iv),
    d: bytesToBase64(new Uint8Array(encrypted)),
  }

  return `${ENCRYPTED_PREFIX}${btoa(JSON.stringify(payload))}`
}

async function decryptText(storedValue, secret, context = '') {
  if (!isEncryptedPassword(storedValue)) {
    throw new Error('not encrypted')
  }

  const raw = storedValue.slice(ENCRYPTED_PREFIX.length)
  const payload = JSON.parse(atob(raw))

  const salt = base64ToBytes(payload.s)
  const iv = base64ToBytes(payload.i)
  const data = base64ToBytes(payload.d)
  const keySource = context ? `${secret}:${context}` : secret
  const key = await deriveAesKey(keySource, salt)
  const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, data)
  return decoder.decode(decrypted)
}

async function tryDecryptText(storedValue, secretCandidates, context = '') {
  for (const secret of secretCandidates) {
    try {
      return await decryptText(storedValue, secret, context)
    } catch {
      try {
        // Legacy payload may not include context-bound key derivation.
        return await decryptText(storedValue, secret)
      } catch {
        // Try next candidate.
      }
    }
  }
  throw new Error('decrypt failed with all candidates')
}

async function encryptPassword(plainText, masterKey) {
  if (!plainText) return ''
  if (!masterKey) throw new Error('master key missing')
  return encryptText(plainText, masterKey, 'password')
}

async function decryptPassword(storedValue, masterKey) {
  if (!storedValue) return ''
  if (!isEncryptedPassword(storedValue)) return storedValue
  if (!masterKey) throw new Error('master key missing')
  return tryDecryptText(storedValue, [masterKey], 'password')
}

function openClientFsDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(CLIENT_FS_DB_NAME, 1)

    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(CLIENT_FS_DB_STORE)) {
        db.createObjectStore(CLIENT_FS_DB_STORE)
      }
    }

    request.onsuccess = () => {
      resolve(request.result)
    }

    request.onerror = () => {
      reject(request.error || new Error('indexeddb open failed'))
    }
  })
}

async function readPersistedRootDirHandle() {
  if (!window.indexedDB) return null

  const db = await openClientFsDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(CLIENT_FS_DB_STORE, 'readonly')
    const store = tx.objectStore(CLIENT_FS_DB_STORE)
    const request = store.get(CLIENT_FS_DB_KEY)

    request.onsuccess = () => {
      resolve(request.result || null)
    }

    request.onerror = () => {
      reject(request.error || new Error('indexeddb read failed'))
    }

    tx.oncomplete = () => {
      db.close()
    }

    tx.onerror = () => {
      db.close()
    }
  })
}

async function persistRootDirHandle(handle) {
  if (!window.indexedDB) return

  const db = await openClientFsDb()
  await new Promise((resolve, reject) => {
    const tx = db.transaction(CLIENT_FS_DB_STORE, 'readwrite')
    const store = tx.objectStore(CLIENT_FS_DB_STORE)
    const request = store.put(handle, CLIENT_FS_DB_KEY)

    request.onsuccess = () => {
      resolve()
    }

    request.onerror = () => {
      reject(request.error || new Error('indexeddb write failed'))
    }

    tx.oncomplete = () => {
      db.close()
    }

    tx.onerror = () => {
      db.close()
    }
  })
}

function formatBackupTimestamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0')
  const ms = String(date.getMilliseconds()).padStart(3, '0')
  const yyyy = date.getFullYear()
  const mm = pad(date.getMonth() + 1)
  const dd = pad(date.getDate())
  const hh = pad(date.getHours())
  const min = pad(date.getMinutes())
  const ss = pad(date.getSeconds())
  return `${yyyy}-${mm}-${dd}-${hh}${min}${ss}-${ms}`
}

function supportsDirectoryPicker() {
  return typeof window.showDirectoryPicker === 'function'
}

function canUseLocalStorageFallback() {
  try {
    return typeof window.localStorage !== 'undefined'
  } catch {
    return false
  }
}

function getStorageMode() {
  if (supportsDirectoryPicker() && window.isSecureContext) {
    return 'file-system'
  }
  if (canUseLocalStorageFallback()) {
    return 'local-storage'
  }
  return 'unavailable'
}

function App() {
  const [isUnlocked, setIsUnlocked] = useState(false)
  const [authForm, setAuthForm] = useState({ masterKey: '' })
  const [authError, setAuthError] = useState('')
  const [recoveryPrompt, setRecoveryPrompt] = useState({ open: false, message: '' })
  const [initPrompt, setInitPrompt] = useState({
    open: false,
    message: '',
    items: [],
  })
  const [exportPrompt, setExportPrompt] = useState({
    open: false,
    masterKey: '',
    error: '',
    resetCredentials: false,
  })
  const [excelExportPrompt, setExcelExportPrompt] = useState({
    open: false,
    masterKey: '',
    error: '',
    resetCredentials: false,
  })
  const [activeMasterKey, setActiveMasterKey] = useState('')
  const [items, setItems] = useState([])
  const [isDataLoaded, setIsDataLoaded] = useState(false)
  const [isSyncing, setIsSyncing] = useState(false)
  const [offlineZipFileName, setOfflineZipFileName] = useState('')
  const [form, setForm] = useState(initialForm)
  const [isFormOpen, setIsFormOpen] = useState(false)
  const [editingPassword, setEditingPassword] = useState('')
  const [filters, setFilters] = useState(initialFilters)
  const [revealedPasswords, setRevealedPasswords] = useState({})
  const [undecryptablePasswordIds, setUndecryptablePasswordIds] = useState({})
  const [isCapsLockOn, setIsCapsLockOn] = useState(false)
  const [isKoreanInputDetected, setIsKoreanInputDetected] = useState(false)
  const [changeDataFolderOnUnlock, setChangeDataFolderOnUnlock] = useState(false)
  const [isFormPasswordCapsLockOn, setIsFormPasswordCapsLockOn] = useState(false)
  const [isFormPasswordKoreanInputDetected, setIsFormPasswordKoreanInputDetected] = useState(false)
  const [isImportCapsLockOn, setIsImportCapsLockOn] = useState(false)
  const [isImportKoreanInputDetected, setIsImportKoreanInputDetected] = useState(false)
  const [isExportCapsLockOn, setIsExportCapsLockOn] = useState(false)
  const [isExportKoreanInputDetected, setIsExportKoreanInputDetected] = useState(false)
  const [isExcludeFiltersOpen, setIsExcludeFiltersOpen] = useState(false)
  const [pendingImport, setPendingImport] = useState({
    open: false,
    text: '',
    fileName: '',
    masterKey: '',
    error: '',
  })
  const [pendingExcelImport, setPendingExcelImport] = useState({
    open: false,
    buffer: null,
    fileName: '',
    requiresMasterKey: true,
    masterKey: '',
    error: '',
  })
  const [actionToast, setActionToast] = useState('')
  const [notice, setNotice] = useState('')
  const [formErrorModal, setFormErrorModal] = useState({
    open: false,
    message: '',
  })
  const [infoModal, setInfoModal] = useState({
    open: false,
    title: '알림',
    message: '',
  })
  const [deleteConfirmModal, setDeleteConfirmModal] = useState({
    open: false,
    ids: [],
  })
  const [rowSelectionModel, setRowSelectionModel] = useState({
    type: 'include',
    ids: new Set(),
  })
  const [paginationModel, setPaginationModel] = useState({
    pageSize: 25,
    page: 0,
  })
  const excelFileInputRef = useRef(null)
  const jsonFileInputRef = useRef(null)
  const clientRootDirHandleRef = useRef(null)
  const formFirstInputRef = useRef(null)
  const revealTimersRef = useRef({})
  const toastTimerRef = useRef(null)

  useEffect(() => () => {
    Object.values(revealTimersRef.current).forEach((timerId) => {
      clearTimeout(timerId)
    })
    if (toastTimerRef.current) {
      clearTimeout(toastTimerRef.current)
    }
  }, [])

  useEffect(() => {
    let mounted = true

    const loadOfflineZipMeta = async () => {
      try {
        const response = await fetch('/api/offline-exe-meta')
        if (!response.ok) {
          if (mounted) setOfflineZipFileName('')
          return
        }
        const parsed = await response.json()
        if (mounted) {
          setOfflineZipFileName(String(parsed?.fileName || ''))
        }
      } catch {
        if (mounted) setOfflineZipFileName('')
      }
    }

    loadOfflineZipMeta()
    return () => {
      mounted = false
    }
  }, [])

  const ensureClientDataFileHandle = async ({ forceSelectDirectory = false } = {}) => {
    if (!window.showDirectoryPicker) {
      throw new Error('file-system-access-not-supported')
    }

    if (!clientRootDirHandleRef.current) {
      try {
        clientRootDirHandleRef.current = await readPersistedRootDirHandle()
      } catch {
        clientRootDirHandleRef.current = null
      }
    }

    let rootHandle = forceSelectDirectory ? null : clientRootDirHandleRef.current
    let permission = rootHandle
      ? await rootHandle.queryPermission({ mode: 'readwrite' })
      : 'prompt'

    if (permission !== 'granted') {
      if (rootHandle) {
        permission = await rootHandle.requestPermission({ mode: 'readwrite' })
      }

      if (permission !== 'granted') {
        rootHandle = await window.showDirectoryPicker({
          id: 'server-access-manager-data-root',
          mode: 'readwrite',
        })
        permission = await rootHandle.requestPermission({ mode: 'readwrite' })
      }
    }

    if (permission !== 'granted') {
      throw new Error('file-system-permission-denied')
    }

    clientRootDirHandleRef.current = rootHandle
    try {
      await persistRootDirHandle(rootHandle)
    } catch {
      // Continue even if persistence fails; current session still works.
    }

    try {
      return await rootHandle.getFileHandle(CLIENT_DATA_FILE, { create: false })
    } catch {
      try {
        // One-time migration for users who previously saved under data/server-access-items.json.
        const legacyDirHandle = await rootHandle.getDirectoryHandle(LEGACY_CLIENT_DATA_DIR, { create: false })
        const legacyFileHandle = await legacyDirHandle.getFileHandle(CLIENT_DATA_FILE, { create: false })
        const legacyText = await (await legacyFileHandle.getFile()).text()

        const rootFileHandle = await rootHandle.getFileHandle(CLIENT_DATA_FILE, { create: true })
        const writable = await rootFileHandle.createWritable()
        await writable.write(legacyText || '{"items": []}\n')
        await writable.close()
        return rootFileHandle
      } catch {
        return rootHandle.getFileHandle(CLIENT_DATA_FILE, { create: true })
      }
    }
  }

  const supportsClientFileAccess = () => getStorageMode() === 'file-system'

  const loadStoragePayloadFromClient = async () => {
    if (getStorageMode() === 'local-storage') {
      const raw = window.localStorage.getItem(CLIENT_STORAGE_FALLBACK_KEY)
      if (!raw || !raw.trim()) {
        return { items: [] }
      }
      return JSON.parse(raw)
    }

    const fileHandle = await ensureClientDataFileHandle()
    const file = await fileHandle.getFile()
    const text = await file.text()

    if (!text.trim()) {
      return { items: [] }
    }

    return JSON.parse(text)
  }

  const saveStoragePayloadToClient = async (payloadToSave, { recreateFile = false } = {}) => {
    if (getStorageMode() === 'local-storage') {
      window.localStorage.setItem(
        CLIENT_STORAGE_FALLBACK_KEY,
        `${JSON.stringify(payloadToSave, null, 2)}\n`,
      )
      return
    }

    let fileHandle

    if (recreateFile) {
      const rootHandle = clientRootDirHandleRef.current || await (async () => {
        await ensureClientDataFileHandle()
        return clientRootDirHandleRef.current
      })()

      try {
        await rootHandle.removeEntry(CLIENT_DATA_FILE)
      } catch (error) {
        // Ignore if there was no file to delete.
        if (error?.name !== 'NotFoundError') {
          throw error
        }
      }

      fileHandle = await rootHandle.getFileHandle(CLIENT_DATA_FILE, { create: true })
    } else {
      fileHandle = await ensureClientDataFileHandle()
    }

    const writable = await fileHandle.createWritable()
    await writable.write(`${JSON.stringify(payloadToSave, null, 2)}\n`)
    await writable.close()
  }

  const backupCurrentStorageFileInClient = async () => {
    if (getStorageMode() === 'local-storage') {
      const currentText = window.localStorage.getItem(CLIENT_STORAGE_FALLBACK_KEY)
      if (!currentText) {
        return ''
      }

      const backupName = `${CLIENT_BACKUP_FILE_PREFIX}-${formatBackupTimestamp()}.local-storage.json`
      window.localStorage.setItem(backupName, currentText)
      return backupName
    }

    await ensureClientDataFileHandle()

    const rootHandle = clientRootDirHandleRef.current
    if (!rootHandle) {
      throw new Error('client-root-handle-missing')
    }

    try {
      const sourceFileHandle = await rootHandle.getFileHandle(CLIENT_DATA_FILE, { create: false })
      const sourceText = await (await sourceFileHandle.getFile()).text()
      const backupName = `${CLIENT_BACKUP_FILE_PREFIX}-${formatBackupTimestamp()}.json`
      const backupFileHandle = await rootHandle.getFileHandle(backupName, { create: true })
      const writable = await backupFileHandle.createWritable()
      await writable.write(sourceText || '{"items": []}\n')
      await writable.close()
      return backupName
    } catch (error) {
      if (error?.name === 'NotFoundError') {
        return ''
      }
      throw error
    }
  }

  const createEncryptedStoragePayload = async (sourceItems, masterKey) => ({
    format: STORAGE_FORMAT,
    encrypted: true,
    encryptedAt: new Date().toISOString(),
    data: await encryptText(JSON.stringify(sourceItems), masterKey, 'storage'),
  })

  const saveStoragePayload = async (payloadToSave) => {
    await saveStoragePayloadToClient(payloadToSave)
  }

  useEffect(() => {
    if (!isUnlocked || !activeMasterKey) {
      setItems([])
      setIsDataLoaded(false)
      return undefined
    }

    let cancelled = false

    const loadItems = async () => {
      try {
        const payload = await loadStoragePayloadFromClient()

        if (payload?.format === STORAGE_FORMAT && payload?.encrypted === true && typeof payload?.data === 'string') {
          try {
            const decrypted = await tryDecryptText(
              payload.data,
              [activeMasterKey],
              'storage',
            )
            const parsed = JSON.parse(decrypted)
            if (!Array.isArray(parsed)) {
              throw new Error('invalid encrypted storage format')
            }

            if (cancelled) return
            setItems(normalizeItems(parsed))
            setAuthError('')
            setIsDataLoaded(true)
            return
          } catch {
            if (cancelled) return
            setIsUnlocked(false)
            setItems([])
            setIsDataLoaded(false)
            setAuthError('입력한 마스터키로 기존 저장소를 복호화할 수 없습니다.')
            setRecoveryPrompt({
              open: true,
              message:
                '기존 파일은 다른 마스터키로 암호화되어 있습니다.\n'
                + '새로운 파일을 생성할까요?(새로운 파일은 빈 저장소 입니다.)\n'
                
            })
            return
          }
        }

        const loadedItems = Array.isArray(payload?.items)
          ? payload.items
          : (Array.isArray(payload) ? payload : [])

        if (cancelled) return

        const normalized = normalizeItems(loadedItems)
        setIsUnlocked(false)
        setItems([])
        setIsDataLoaded(false)
        setAuthError('')        //setNotice('JSON 저장소가 없어 새로 생성했거나 기존 형식을 암호화 저장소로 변환했습니다.')
        setInitPrompt({
          open: true,
          message:
            '저장소 파일이 없습니다.\n'
            + '현재 입력한 마스터키로 암호화 저장소를 생성할까요?',
          items: normalized,
        })
        return
      } catch {
        if (!cancelled) {
          setIsUnlocked(false)
          setActiveMasterKey('')
          setItems([])
          setIsDataLoaded(false)
          setAuthError('마스터키가 올바르지 않거나 저장소 복호화에 실패했습니다.')
          setNotice('')
        }
      }
    }

    loadItems()

    return () => {
      cancelled = true
    }
  }, [isUnlocked, activeMasterKey])

  const onCancelInitPrompt = () => {
    setInitPrompt({ open: false, message: '', items: [] })
    setActiveMasterKey('')
    setAuthError('저장소 생성이 취소되었습니다. 다시 인증해주세요.')
  }

  const onConfirmInitPrompt = async () => {
    if (!activeMasterKey) {
      setInitPrompt({ open: false, message: '', items: [] })
      setAuthError('마스터키 세션이 만료되었습니다. 다시 인증해주세요.')
      return
    }

    try {
      const payload = await createEncryptedStoragePayload(initPrompt.items, activeMasterKey)
      await saveStoragePayload(payload)

      setItems(initPrompt.items)
      setInitPrompt({ open: false, message: '', items: [] })
      setIsUnlocked(true)
      setIsDataLoaded(true)
      setAuthError('')
      setNotice('저장소를 생성했습니다.')
    } catch {
      setInitPrompt({ open: false, message: '', items: [] })
      setActiveMasterKey('')
      setAuthError('저장소 생성에 실패했습니다. 다시 인증해주세요.')
    }
  }

  const onCancelRecoveryPrompt = () => {
    setRecoveryPrompt({ open: false, message: '' })
    setActiveMasterKey('')
  }

  const onConfirmCreateNewStorage = async () => {
    if (!activeMasterKey) {
      setRecoveryPrompt({ open: false, message: '' })
      setAuthError('마스터키 세션이 만료되었습니다. 다시 입력해주세요.')
      return
    }

    try {
      const backupFileName = await backupCurrentStorageFileInClient()
      const emptyPayload = await createEncryptedStoragePayload([], activeMasterKey)
      await saveStoragePayloadToClient(emptyPayload, { recreateFile: true })
      setRecoveryPrompt({ open: false, message: '' })
      setItems([])
      setIsDataLoaded(true)
      setAuthError('')
      setNotice(
        backupFileName
          ? `기존 저장소를 ${backupFileName} 파일로 백업하고 새 저장소를 생성했습니다.`
          : '새 저장소를 생성했습니다.',
      )
      setIsUnlocked(true)
    } catch {
      setRecoveryPrompt({ open: false, message: '' })
      setActiveMasterKey('')
      setAuthError('새 저장소 생성에 실패했습니다. 다시 시도해주세요.')
    }
  }

  useEffect(() => {
    if (!isUnlocked || !activeMasterKey || !isDataLoaded) return

    let cancelled = false

    const persistItems = async () => {
      try {
        const payloadToSave = {
          format: STORAGE_FORMAT,
          encrypted: true,
          encryptedAt: new Date().toISOString(),
          data: await encryptText(JSON.stringify(items), activeMasterKey, 'storage'),
        }

        setIsSyncing(true)
        await saveStoragePayload(payloadToSave)

      } catch {
        if (!cancelled) {
          setNotice('파일 저장소 저장에 실패했습니다. 잠시 후 다시 시도해주세요.')
        }
      } finally {
        if (!cancelled) {
          setIsSyncing(false)
        }
      }
    }

    persistItems()

    return () => {
      cancelled = true
    }
  }, [items, isDataLoaded, isUnlocked, activeMasterKey])

  useEffect(() => {
    if (!isUnlocked || !activeMasterKey || !isDataLoaded) {
      setUndecryptablePasswordIds({})
      return undefined
    }

    let cancelled = false

    const detectUndecryptablePasswords = async () => {
      const next = {}

      for (const item of items) {
        if (!item?.password || !isEncryptedPassword(item.password)) {
          continue
        }

        try {
          await decryptPassword(item.password, activeMasterKey)
        } catch {
          next[item.id] = true
        }
      }

      if (!cancelled) {
        setUndecryptablePasswordIds(next)
      }
    }

    detectUndecryptablePasswords()

    return () => {
      cancelled = true
    }
  }, [items, isDataLoaded, isUnlocked, activeMasterKey])

  useEffect(() => {
    setRowSelectionModel((prev) => {
      if (prev?.type !== 'include' || !(prev.ids instanceof Set) || prev.ids.size === 0) {
        return prev
      }

      const validIds = new Set(items.map((item) => item.id))
      const nextIds = new Set([...prev.ids].filter((id) => validIds.has(id)))
      return nextIds.size === prev.ids.size
        ? prev
        : { ...prev, ids: nextIds }
    })
  }, [items])

  const filteredItems = useMemo(() => {
    const groupQ = filters.group.trim().toLowerCase()
    const nameQ = filters.name.trim().toLowerCase()
    const envQ = filters.environment.trim().toLowerCase()
    const hostQ = filters.host.trim().toLowerCase()
    const databaseQ = filters.database.trim().toLowerCase()
    const excludeGroupQ = filters.excludeGroup.trim().toLowerCase()
    const excludeNameQ = filters.excludeName.trim().toLowerCase()
    const excludeEnvQ = filters.excludeEnvironment.trim().toLowerCase()
    const excludeHostQ = filters.excludeHost.trim().toLowerCase()
    const excludeDatabaseQ = filters.excludeDatabase.trim().toLowerCase()

    if (!groupQ && !nameQ && !envQ && !hostQ && !databaseQ && !excludeGroupQ && !excludeNameQ && !excludeEnvQ && !excludeHostQ && !excludeDatabaseQ) {
      return items
    }

    return items.filter((item) => {
      // 포함 조건
      const matchGroup = !groupQ || (item.group || '').toLowerCase().includes(groupQ)
      const matchName = !nameQ || (item.name || '').toLowerCase().includes(nameQ)
      const matchEnvironment = !envQ || (item.environment || '').toLowerCase() === envQ
      const matchHost = !hostQ || (item.host || '').toLowerCase().includes(hostQ)
      const matchDatabase = !databaseQ || (item.database || '').toLowerCase().includes(databaseQ)

      // 제외 조건
      const notExcludeGroup = !excludeGroupQ || !(item.group || '').toLowerCase().includes(excludeGroupQ)
      const notExcludeName = !excludeNameQ || !(item.name || '').toLowerCase().includes(excludeNameQ)
      const notExcludeEnvironment = !excludeEnvQ || (item.environment || '').toLowerCase() !== excludeEnvQ
      const notExcludeHost = !excludeHostQ || !(item.host || '').toLowerCase().includes(excludeHostQ)
      const notExcludeDatabase = !excludeDatabaseQ || !(item.database || '').toLowerCase().includes(excludeDatabaseQ)

      return (
        matchGroup &&
        matchName &&
        matchEnvironment &&
        matchHost &&
        matchDatabase &&
        notExcludeGroup &&
        notExcludeName &&
        notExcludeEnvironment &&
        notExcludeHost &&
        notExcludeDatabase
      )
    })
  }, [items, filters])

  const hasActiveFilters = useMemo(() => Object.values(filters).some((value) => String(value || '').trim() !== ''), [filters])

  useEffect(() => {
    setRowSelectionModel((prev) => {
      if (prev?.type !== 'include' || !(prev.ids instanceof Set) || prev.ids.size === 0) {
        return prev
      }

      const visibleIds = new Set(filteredItems.map((item) => item.id))
      const nextIds = new Set([...prev.ids].filter((id) => visibleIds.has(id)))
      return nextIds.size === prev.ids.size
        ? prev
        : { ...prev, ids: nextIds }
    })
  }, [filteredItems])

  useEffect(() => {
    setPaginationModel((prev) => ({ ...prev, page: 0 }))
  }, [filters])

  useEffect(() => {
    if (!isFormOpen || !form.id) return
    const timer = setTimeout(() => {
      formFirstInputRef.current?.focus()
      formFirstInputRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }, 0)

    return () => {
      clearTimeout(timer)
    }
  }, [isFormOpen, form.id])

  const onChangeFilter = (event) => {
    const { name, value } = event.target
    setFilters((prev) => ({ ...prev, [name]: value }))
  }

  const onChangeField = (event) => {
    const { name, value } = event.target
    if (name === 'password') {
      const hasHangul = /[ㄱ-ㅎㅏ-ㅣ가-힣]/.test(value)
      setIsFormPasswordKoreanInputDetected(hasHangul)
    }
    setForm((prev) => ({ ...prev, [name]: value }))
  }

  const onPasswordFieldKeyDown = (event) => {
    if (typeof event.getModifierState === 'function') {
      setIsFormPasswordCapsLockOn(event.getModifierState('CapsLock'))
    }
    if (event.key === 'Process') {
      setIsFormPasswordKoreanInputDetected(true)
    }
  }

  const onPasswordFieldKeyUp = (event) => {
    if (typeof event.getModifierState === 'function') {
      setIsFormPasswordCapsLockOn(event.getModifierState('CapsLock'))
    }
  }

  const getMasterKeyValidationError = (masterKey) => {
    if (!masterKey) return '마스터키를 입력해주세요.'
    if (masterKey.length < MASTER_KEY_MIN_LENGTH) {
      return `마스터키는 최소 ${MASTER_KEY_MIN_LENGTH}자리 이상이어야 합니다.`
    }
    if (!MASTER_KEY_ALLOWED_REGEX.test(masterKey)) {
      return '마스터키는 영문, 숫자, 특수문자만 사용할 수 있습니다.'
    }
    if (!MASTER_KEY_LETTER_REGEX.test(masterKey)) {
      return '마스터키에 영문을 최소 1자 이상 포함해주세요.'
    }
    if (!MASTER_KEY_DIGIT_REGEX.test(masterKey)) {
      return '마스터키에 숫자를 최소 1자 이상 포함해주세요.'
    }
    if (!MASTER_KEY_SPECIAL_REGEX.test(masterKey)) {
      return '마스터키에 특수문자를 최소 1자 이상 포함해주세요.'
    }
    return ''
  }

  const onChangeMasterKey = (event) => {
    const { value } = event.target

    const hasHangul = /[ㄱ-ㅎㅏ-ㅣ가-힣]/.test(value)
    setIsKoreanInputDetected(hasHangul)

    const validationError = getMasterKeyValidationError(value)
    if (value && validationError) {
      setAuthError(validationError)
    } else {
      setAuthError('')
    }

    setAuthForm({ masterKey: value })
  }

  const updateCapsLockState = (event) => {
    if (typeof event.getModifierState !== 'function') return
    setIsCapsLockOn(event.getModifierState('CapsLock'))
  }

  const onUnlock = async () => {
    const enteredMasterKey = authForm.masterKey
    const validationError = getMasterKeyValidationError(enteredMasterKey)
    if (validationError) {
      setAuthError(validationError)
      return
    }

    const storageMode = getStorageMode()

    if (storageMode === 'file-system') {
      try {
        await ensureClientDataFileHandle({ forceSelectDirectory: changeDataFolderOnUnlock })
      } catch (error) {
        if (error?.name === 'AbortError') {
          setAuthError('데이터 폴더 선택이 취소되었습니다.')
          return
        }
        if (error?.message === 'file-system-permission-denied') {
          setAuthError('선택한 폴더에 대한 읽기/쓰기 권한이 필요합니다.')
          return
        }

        setAuthError('로컬 데이터 파일 준비에 실패했습니다. 다시 시도해주세요.')
        return
      }
    } else if (storageMode === 'local-storage') {
      setNotice('현재 브라우저는 폴더 직접 접근을 지원하지 않아 브라우저 저장소(localStorage) 모드로 동작합니다.')
    } else {
      setAuthError('이 브라우저 환경에서는 저장소 기능을 사용할 수 없습니다. HTTPS 접속 후 Chrome/Edge에서 다시 시도해주세요.')
      return
    }

    setActiveMasterKey(enteredMasterKey)
    setIsUnlocked(true)
    setAuthForm({ masterKey: '' })
    setIsCapsLockOn(false)
    setIsKoreanInputDetected(false)
    if (storageMode === 'file-system') {
      setChangeDataFolderOnUnlock(false)
    }
    setAuthError('')
  }

  const onAuthKeyDown = (event) => {
    updateCapsLockState(event)

    if (event.key === 'Process') {
      setIsKoreanInputDetected(true)
    }

    if (event.key !== 'Enter') return
    event.preventDefault()
    onUnlock()
  }

  const onLock = () => {
    setIsUnlocked(false)
    setActiveMasterKey('')
    setItems([])
    setIsDataLoaded(false)
    setRevealedPasswords({})
    setUndecryptablePasswordIds({})
    setIsCapsLockOn(false)
    setIsKoreanInputDetected(false)
    setIsFormPasswordCapsLockOn(false)
    setIsFormPasswordKoreanInputDetected(false)
    setFilters(initialFilters)
    setRowSelectionModel({ type: 'include', ids: new Set() })
    setNotice('')
  }

  const resetForm = () => {
    setForm(initialForm)
    setEditingPassword('')
    setIsFormPasswordCapsLockOn(false)
    setIsFormPasswordKoreanInputDetected(false)
  }

  const showActionToast = (message) => {
    setActionToast(message)
    if (toastTimerRef.current) {
      clearTimeout(toastTimerRef.current)
    }
    toastTimerRef.current = setTimeout(() => {
      setActionToast('')
      toastTimerRef.current = null
    }, 2200)
  }

  const openFormErrorModal = (message) => {
    setFormErrorModal({ open: true, message })
  }

  const closeFormErrorModal = () => {
    setFormErrorModal({ open: false, message: '' })
  }

  const openInfoModal = (message, title = '알림') => {
    setInfoModal({ open: true, title, message })
  }

  const closeInfoModal = () => {
    setInfoModal({ open: false, title: '알림', message: '' })
  }

  const onSubmit = async (event) => {
    event.preventDefault()
    if (!form.name.trim() || !form.host.trim() || !form.username.trim()) {
      openFormErrorModal('이름, 호스트, 계정은 필수입니다.')
      return
    }

    let nextPassword = editingPassword
    const enteredPassword = form.password.trim()

    if (enteredPassword) {
      try {
        nextPassword = await encryptPassword(enteredPassword, activeMasterKey)
      } catch {
        openFormErrorModal('비밀번호 암호화에 실패했습니다. 다시 시도해주세요.')
        return
      }
    }

    const nextPort = String(form.port ?? '').trim()

    const payload = {
      ...form,
      port: nextPort,
      password: nextPassword,
    }

    const payloadKey = getImportMergeKey(payload)
    setItems((prev) => {
      const next = [...prev]
      const matchedByKeyIndex = next.findIndex(
        (item) => getImportMergeKey(item) === payloadKey,
      )
      const editingIndex = form.id
        ? next.findIndex((item) => item.id === form.id)
        : -1

      if (matchedByKeyIndex !== -1) {
        const existing = next[matchedByKeyIndex]
        next[matchedByKeyIndex] = {
          ...existing,
          ...payload,
          id: existing.id,
        }

        if (editingIndex !== -1 && editingIndex !== matchedByKeyIndex) {
          next.splice(editingIndex, 1)
        }
        return next
      }

      if (editingIndex !== -1) {
        const existing = next[editingIndex]
        next[editingIndex] = {
          ...existing,
          ...payload,
          id: existing.id,
        }
        return next
      }

      const created = {
        ...payload,
        id: `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
      }
      return [created, ...next]
    })

    setNotice(form.id ? '접속정보를 수정했습니다.' : '접속정보를 저장했습니다.')
    showActionToast(form.id ? '수정이 완료되었습니다.' : '저장이 완료되었습니다.')

    resetForm()
  }

  const onEdit = (item) => {
    setEditingPassword(item.password || '')
    setForm({
      ...item,
      port: item.port === undefined || item.port === null ? '' : String(item.port),
      password: '',
    })
    setIsFormOpen(true)
    setIsFormPasswordCapsLockOn(false)
    setIsFormPasswordKoreanInputDetected(false)
    setNotice('수정 모드로 전환했습니다.')
  }

  const normalizeItems = (source) => source.map((item, idx) => ({
    id: item.id || `${Date.now()}-${idx}`,
    group: item.group || '',
    name: item.name || '',
    environment: item.environment || 'DEV',
    host: item.host || '',
    port: item.port === undefined || item.port === null ? '' : String(item.port),
    username: item.username || '',
    password: item.password || '',
    database: item.database || '',
    memo: item.memo || '',
  }))

  const getImportMergeKey = (item) => {
    const username = (item.username || '').trim().toLowerCase()
    const host = (item.host || '').trim().toLowerCase()
    if (!username || !host) return null
    return `${username}||${host}`
  }

  const mergeItemsByAccountHost = (currentItems, importedItems) => {
    const merged = [...currentItems]
    const indexByKey = new Map()

    merged.forEach((item, idx) => {
      const key = getImportMergeKey(item)
      if (key) {
        indexByKey.set(key, idx)
      }
    })

    importedItems.forEach((item) => {
      const key = getImportMergeKey(item)
      const foundIndex = key ? indexByKey.get(key) : undefined

      if (foundIndex !== undefined) {
        const existing = merged[foundIndex]
        merged[foundIndex] = {
          ...existing,
          ...item,
          id: existing.id,
        }
        return
      }

      merged.push(item)
      if (key) {
        indexByKey.set(key, merged.length - 1)
      }
    })

    return merged
  }

  const getMergeReportByAccountHost = (currentItems, importedItems) => {
    const existingKeys = new Set(
      currentItems
        .map((item) => getImportMergeKey(item))
        .filter(Boolean),
    )
    const seenNewImportKeys = new Set()

    let added = 0
    let updated = 0
    let duplicated = 0

    importedItems.forEach((item) => {
      const key = getImportMergeKey(item)
      if (key && existingKeys.has(key)) {
        updated += 1
        return
      }

      // Same account+host repeated inside the import file does not create
      // additional rows in merge result, so count it separately.
      if (key && seenNewImportKeys.has(key)) {
        duplicated += 1
        return
      }

      added += 1
      if (key) {
        seenNewImportKeys.add(key)
      }
    })

    return { added, updated, duplicated }
  }

  const convertItemPasswordsToKey = async (sourceItems, sourceKey, targetKey) => Promise.all(
    sourceItems.map(async (item) => {
      if (!item.password) return item

      if (!isEncryptedPassword(item.password)) {
        return {
          ...item,
          password: await encryptPassword(item.password, targetKey),
        }
      }

      if (sourceKey === targetKey) return item

      const plain = await decryptPassword(item.password, sourceKey)
      return {
        ...item,
        password: await encryptPassword(plain, targetKey),
      }
    }),
  )

  const getSelectedIdSet = () => {
    const visibleIds = new Set(filteredItems.map((item) => item.id))

    if (rowSelectionModel?.type === 'include' && rowSelectionModel.ids instanceof Set) {
      return new Set([...rowSelectionModel.ids].filter((id) => visibleIds.has(id)))
    }

    if (rowSelectionModel?.type === 'exclude' && rowSelectionModel.ids instanceof Set) {
      const excluded = rowSelectionModel.ids
      return new Set(filteredItems.filter((item) => !excluded.has(item.id)).map((item) => item.id))
    }

    return new Set()
  }

  const onDeleteSelected = () => {
    const selectedIdSet = getSelectedIdSet()
    const deleteCount = selectedIdSet.size

    if (!deleteCount) {
      openInfoModal('삭제할 항목을 먼저 체크해주세요.')
      return
    }

    setDeleteConfirmModal({
      open: true,
      ids: [...selectedIdSet],
    })
  }

  const onCancelDeleteConfirm = () => {
    setDeleteConfirmModal({ open: false, ids: [] })
  }

  const onConfirmDeleteSelected = () => {
    const selectedIdSet = new Set(deleteConfirmModal.ids)
    const deleteCount = selectedIdSet.size
    if (!deleteCount) {
      setDeleteConfirmModal({ open: false, ids: [] })
      return
    }

    setDeleteConfirmModal({ open: false, ids: [] })

    setItems((prev) => prev.filter((item) => !selectedIdSet.has(item.id)))

    if (form.id && selectedIdSet.has(form.id)) {
      resetForm()
    }

    setRevealedPasswords((prev) => {
      let changed = false
      const next = { ...prev }
      selectedIdSet.forEach((id) => {
        if (next[id]) {
          delete next[id]
          changed = true
        }
      })
      return changed ? next : prev
    })

    selectedIdSet.forEach((id) => {
      if (revealTimersRef.current[id]) {
        clearTimeout(revealTimersRef.current[id])
        delete revealTimersRef.current[id]
      }
    })

    setRowSelectionModel({ type: 'include', ids: new Set() })
    setNotice(`선택한 ${deleteCount}건을 삭제했습니다.`)
    showActionToast(`${deleteCount}건 삭제 완료`)
  }

  const onOpenExportPrompt = () => {
    if (getSelectedIdSet().size === 0) {
      openInfoModal('내보낼 항목을 먼저 체크해주세요.')
      return
    }
    setIsExportCapsLockOn(false)
    setIsExportKoreanInputDetected(false)
    setExportPrompt({ open: true, masterKey: '', error: '', resetCredentials: false })
  }

  const onCancelExportPrompt = () => {
    setIsExportCapsLockOn(false)
    setIsExportKoreanInputDetected(false)
    setExportPrompt({ open: false, masterKey: '', error: '', resetCredentials: false })
  }

  const onChangeExportMasterKey = (event) => {
    const { value } = event.target
    const hasHangul = /[ㄱ-ㅎㅏ-ㅣ가-힣]/.test(value)
    setIsExportKoreanInputDetected(hasHangul)

    const validationError = getMasterKeyValidationError(value)
    setExportPrompt((prev) => ({
      ...prev,
      masterKey: value,
      error: value && validationError ? validationError : '',
    }))
  }

  const onExportMasterKeyKeyDown = (event) => {
    if (typeof event.getModifierState === 'function') {
      setIsExportCapsLockOn(event.getModifierState('CapsLock'))
    }

    if (event.key === 'Process') {
      setIsExportKoreanInputDetected(true)
    }

    if (event.key !== 'Enter') return
    event.preventDefault()
    onConfirmExport()
  }

  const onExportMasterKeyKeyUp = (event) => {
    if (typeof event.getModifierState === 'function') {
      setIsExportCapsLockOn(event.getModifierState('CapsLock'))
    }
  }

  const saveExportJson = async (exportPayload, fileName) => {
    const text = JSON.stringify(exportPayload, null, 2)

    if (window.showSaveFilePicker) {
      const handle = await window.showSaveFilePicker({
        suggestedName: fileName,
        types: [
          {
            description: 'JSON files',
            accept: {
              'application/json': ['.json'],
            },
          },
        ],
      })

      const writable = await handle.createWritable()
      await writable.write(text)
      await writable.close()
      return
    }

    const blob = new Blob([text], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = fileName
    a.click()
    URL.revokeObjectURL(url)
  }

  const onConfirmExport = async () => {
    const exportMasterKey = exportPrompt.masterKey
    const shouldResetCredentials = exportPrompt.resetCredentials
    const validationError = getMasterKeyValidationError(exportMasterKey)
    if (validationError) {
      setExportPrompt((prev) => ({ ...prev, error: validationError }))
      return
    }

    try {
      const targetExportKey = exportMasterKey
      const selectedIdSet = getSelectedIdSet()
      const selectedItems = items.filter((item) => selectedIdSet.has(item.id))

      if (!selectedItems.length) {
        setExportPrompt((prev) => ({ ...prev, error: '내보낼 선택 항목이 없습니다.' }))
        return
      }

      const hasUndecryptableSelected = selectedItems.some((item) => undecryptablePasswordIds[item.id])
      if (!shouldResetCredentials && hasUndecryptableSelected) {
        setExportPrompt((prev) => ({
          ...prev,
          error: '선택한 항목 중 현재 마스터키로 복호화할 수 없는 비밀번호가 있습니다. 해당 항목 비밀번호를 수정/저장 후 다시 시도해주세요.',
        }))
        return
      }

      const exportItems = shouldResetCredentials
        ? selectedItems.map((item) => ({
          ...item,
          username: 'init',
          password: 'init',
        }))
        : await convertItemPasswordsToKey(selectedItems, activeMasterKey, targetExportKey)

      const exportPayload = {
        format: EXPORT_FORMAT,
        exportedAt: new Date().toISOString(),
        data: await encryptText(JSON.stringify(exportItems), targetExportKey, 'storage'),
      }

      const fileName = `server-access-backup-${new Date().toISOString().slice(0, 10)}.json`
      await saveExportJson(exportPayload, fileName)
      setExportPrompt({ open: false, masterKey: '', error: '', resetCredentials: false })
      setNotice(
        shouldResetCredentials
          ? '계정/비밀번호를 init으로 초기화한 JSON 파일을 생성했습니다.'
          : '입력한 내보내기 마스터키로 암호화된 JSON 파일을 생성했습니다.',
      )
    } catch (error) {
      if (error?.name === 'AbortError') {
        setNotice('내보내기를 취소했습니다.')
        return
      }
      setExportPrompt((prev) => ({
        ...prev,
        error: '내보내기 생성에 실패했습니다. 선택 항목의 비밀번호 복호화 가능 여부와 마스터키를 확인해주세요.',
      }))
      setNotice('내보내기 생성에 실패했습니다.')
    }
  }

  const onImportExcelClick = () => {
    excelFileInputRef.current?.click()
  }

  const onImportJsonClick = () => {
    jsonFileInputRef.current?.click()
  }

  const onDownloadOfflineExeZip = () => {
    window.location.assign('/api/offline-exe-download')
  }

  const applyImportFromText = async (text, importMasterKey) => {
    try {
      const parsed = JSON.parse(text)

      if (parsed?.format === EXPORT_FORMAT) {
        const decrypted = await tryDecryptText(
          parsed.data,
          [importMasterKey],
          'storage',
        )
        const decryptedItems = JSON.parse(decrypted)
        if (!Array.isArray(decryptedItems)) {
          throw new Error('invalid decrypted format')
        }

        const normalizedImportedItems = normalizeItems(decryptedItems)
        const importedForCurrentVault = await convertItemPasswordsToKey(
          normalizedImportedItems,
          importMasterKey,
          activeMasterKey,
        )
        const reportBaseItems = hasActiveFilters ? filteredItems : items
        const report = getMergeReportByAccountHost(reportBaseItems, importedForCurrentVault)

        setItems((prev) => mergeItemsByAccountHost(prev, importedForCurrentVault))
        resetForm()
        const duplicatedText = report.duplicated > 0
          ? `, 중복 ${report.duplicated}건(가져오기 파일 내부 동일 계정+호스트)`
          : ''
        setNotice(`JSON 가져오기 완료: 추가 ${report.added}건, 수정 ${report.updated}건${duplicatedText}`)
        return
      }

      if (!Array.isArray(parsed)) {
        throw new Error('invalid format')
      }

      const normalized = normalizeItems(parsed)

      const imported = await Promise.all(
        normalized.map(async (item) => {
          if (item.password && !isEncryptedPassword(item.password)) {
            return {
              ...item,
              password: await encryptPassword(item.password, activeMasterKey),
            }
          }
          return item
        }),
      )
      const reportBaseItems = hasActiveFilters ? filteredItems : items
      const report = getMergeReportByAccountHost(reportBaseItems, imported)

      setItems((prev) => mergeItemsByAccountHost(prev, imported))
      const duplicatedText = report.duplicated > 0
        ? `, 중복 ${report.duplicated}건(가져오기 파일 내부 동일 계정+호스트)`
        : ''
      setNotice(`JSON 가져오기 완료: 추가 ${report.added}건, 수정 ${report.updated}건${duplicatedText} (평문 비밀번호 자동 암호화)`)
      resetForm()
    } catch {
      setNotice('가져오기에 실패했습니다. 파일 형식 또는 마스터키를 확인해주세요.')
    }
  }

  const parseExcelRowsToItems = (rows) => rows
    .map((row) => {
      const environment = String(row.환경 || row.environment || '').trim().toUpperCase()
      const normalizedEnvironment = ['DEV', 'STG', 'PROD', 'ETC'].includes(environment)
        ? environment
        : 'DEV'

      return {
        group: String(row.그룹 || row.group || '').trim(),
        name: String(row.이름 || row.name || '').trim(),
        environment: normalizedEnvironment,
        host: String(row.호스트 || row.host || '').trim(),
        port: String(row.포트 || row.port || '').trim(),
        username: String(row.계정 || row.username || '').trim(),
        password: String(row.비밀번호 || row.password || '').trim(),
        database: String(row.구분 || row.database || '').trim(),
        memo: String(row.메모 || row.memo || '').trim(),
      }
    })
    .filter((item) => Object.values(item).some((value) => value !== ''))

  const requiresExcelImportMasterKey = (parsedItems) => parsedItems.some(
    (item) => isEncryptedPassword(item.password),
  )

  const applyImportFromExcel = async (excelBuffer, importMasterKey) => {
    try {
      const workbook = XLSX.read(excelBuffer, { type: 'array' })
      const sheetName = workbook.SheetNames?.[0]
      if (!sheetName) {
        setNotice('엑셀 파일에서 시트를 찾을 수 없습니다.')
        return
      }

      const worksheet = workbook.Sheets[sheetName]
      const rows = XLSX.utils.sheet_to_json(worksheet, {
        raw: false,
        defval: '',
      })

      const parsedItems = parseExcelRowsToItems(rows)
      if (!parsedItems.length) {
        setNotice('엑셀에서 가져올 데이터가 없습니다.')
        return
      }

      const requiredItems = parsedItems.filter(
        (item) => item.name.trim() && item.host.trim() && item.username.trim(),
      )
      const excludedCount = parsedItems.length - requiredItems.length

      if (!requiredItems.length) {
        setNotice('필수값(이름/호스트/계정)이 있는 행이 없어 가져오지 않았습니다.')
        return
      }

      const normalized = normalizeItems(requiredItems)
      const importedForCurrentVault = await convertItemPasswordsToKey(
        normalized,
        importMasterKey,
        activeMasterKey,
      )
      const reportBaseItems = hasActiveFilters ? filteredItems : items
      const report = getMergeReportByAccountHost(reportBaseItems, importedForCurrentVault)
      setItems((prev) => mergeItemsByAccountHost(prev, importedForCurrentVault))
      resetForm()
      const excludedText = excludedCount > 0 ? `, 제외 ${excludedCount}건` : ''
      const duplicatedText = report.duplicated > 0
        ? `, 중복 ${report.duplicated}건(가져오기 파일 내부 동일 계정+호스트)`
        : ''
      setNotice(`엑셀 가져오기 완료: 추가 ${report.added}건, 수정 ${report.updated}건${excludedText}${duplicatedText}`)
    } catch {
      setNotice('엑셀 가져오기에 실패했습니다. 엑셀 마스터키와 파일 형식을 확인해주세요.')
    }
  }

  const onImportExcelFile = async (event) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return

    try {
      const buffer = await file.arrayBuffer()
      const workbook = XLSX.read(buffer, { type: 'array' })
      const sheetName = workbook.SheetNames?.[0]
      if (!sheetName) {
        setNotice('엑셀 파일에서 시트를 찾을 수 없습니다.')
        return
      }

      const worksheet = workbook.Sheets[sheetName]
      const rows = XLSX.utils.sheet_to_json(worksheet, {
        raw: false,
        defval: '',
      })
      const parsedItems = parseExcelRowsToItems(rows)
      const needsMasterKey = requiresExcelImportMasterKey(parsedItems)

      setPendingExcelImport({
        open: true,
        buffer,
        fileName: file.name,
        requiresMasterKey: needsMasterKey,
        masterKey: '',
        error: '',
      })
      setIsImportCapsLockOn(false)
      setIsImportKoreanInputDetected(false)
    } catch {
      setNotice('엑셀 파일 읽기에 실패했습니다.')
    }
  }

  const onChangeExcelImportMasterKey = (event) => {
    const { value } = event.target
    const hasHangul = /[ㄱ-ㅎㅏ-ㅣ가-힣]/.test(value)
    setIsImportKoreanInputDetected(hasHangul)

    const validationError = getMasterKeyValidationError(value)
    setPendingExcelImport((prev) => ({
      ...prev,
      masterKey: value,
      error: value && validationError ? validationError : '',
    }))
  }

  const onCancelExcelImport = () => {
    setIsImportCapsLockOn(false)
    setIsImportKoreanInputDetected(false)
    setPendingExcelImport({
      open: false,
      buffer: null,
      fileName: '',
      requiresMasterKey: true,
      masterKey: '',
      error: '',
    })
    setNotice('엑셀 가져오기를 취소했습니다.')
  }

  const onConfirmExcelImport = async () => {
    const needsMasterKey = pendingExcelImport.requiresMasterKey
    const importMasterKey = pendingExcelImport.masterKey
    if (needsMasterKey) {
      const validationError = getMasterKeyValidationError(importMasterKey)
      if (validationError) {
        setPendingExcelImport((prev) => ({ ...prev, error: validationError }))
        return
      }
    }

    if (!pendingExcelImport.buffer) {
      setPendingExcelImport((prev) => ({ ...prev, error: '엑셀 파일 데이터가 없습니다.' }))
      return
    }

    await applyImportFromExcel(pendingExcelImport.buffer, needsMasterKey ? importMasterKey : '')
    setIsImportCapsLockOn(false)
    setIsImportKoreanInputDetected(false)
    setPendingExcelImport({
      open: false,
      buffer: null,
      fileName: '',
      requiresMasterKey: true,
      masterKey: '',
      error: '',
    })
  }

  const onImportJsonFile = async (event) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return

    const text = await file.text()
    setPendingImport({
      open: true,
      text,
      fileName: file.name,
      masterKey: '',
      error: '',
    })
    setIsImportCapsLockOn(false)
    setIsImportKoreanInputDetected(false)
  }

  const onChangeImportMasterKey = (event) => {
    const { value } = event.target
    const hasHangul = /[ㄱ-ㅎㅏ-ㅣ가-힣]/.test(value)
    setIsImportKoreanInputDetected(hasHangul)

    const validationError = getMasterKeyValidationError(value)
    setPendingImport((prev) => ({
      ...prev,
      masterKey: value,
      error: value && validationError ? validationError : '',
    }))
  }

  const onImportMasterKeyKeyDown = (event) => {
    if (typeof event.getModifierState === 'function') {
      setIsImportCapsLockOn(event.getModifierState('CapsLock'))
    }

    if (event.key === 'Process') {
      setIsImportKoreanInputDetected(true)
    }

    if (event.key !== 'Enter') return
    event.preventDefault()
    if (pendingExcelImport.open) {
      onConfirmExcelImport()
      return
    }
    onConfirmImport()
  }

  const onImportMasterKeyKeyUp = (event) => {
    if (typeof event.getModifierState === 'function') {
      setIsImportCapsLockOn(event.getModifierState('CapsLock'))
    }
  }

  const onCancelImport = () => {
    setIsImportCapsLockOn(false)
    setIsImportKoreanInputDetected(false)
    setPendingImport({
      open: false,
      text: '',
      fileName: '',
      masterKey: '',
      error: '',
    })
    setNotice('가져오기를 취소했습니다.')
  }

  const onConfirmImport = async () => {
    const importMasterKey = pendingImport.masterKey
    const validationError = getMasterKeyValidationError(importMasterKey)
    if (validationError) {
      setPendingImport((prev) => ({ ...prev, error: validationError }))
      return
    }

    await applyImportFromText(pendingImport.text, importMasterKey)
    setIsImportCapsLockOn(false)
    setIsImportKoreanInputDetected(false)
    setPendingImport({
      open: false,
      text: '',
      fileName: '',
      masterKey: '',
      error: '',
    })
  }

  const onToggleReveal = async (item) => {
    if (!item.password) return
    if (undecryptablePasswordIds[item.id]) {
      setNotice('이 항목의 비밀번호는 현재 마스터키로 복호화할 수 없습니다. 수정에서 비밀번호를 다시 입력해 저장해주세요.')
      return
    }

    if (revealedPasswords[item.id]) {
      setRevealedPasswords((prev) => {
        const next = { ...prev }
        delete next[item.id]
        return next
      })
      if (revealTimersRef.current[item.id]) {
        clearTimeout(revealTimersRef.current[item.id])
        delete revealTimersRef.current[item.id]
      }
      return
    }

    try {
      const plain = await decryptPassword(item.password, activeMasterKey)
      setRevealedPasswords((prev) => ({ ...prev, [item.id]: plain || '-' }))
      setNotice('비밀번호가 10초 동안 표시됩니다.')

      if (revealTimersRef.current[item.id]) {
        clearTimeout(revealTimersRef.current[item.id])
      }
      revealTimersRef.current[item.id] = setTimeout(() => {
        setRevealedPasswords((prev) => {
          const next = { ...prev }
          delete next[item.id]
          return next
        })
        delete revealTimersRef.current[item.id]
      }, REVEAL_MS)
    } catch {
      setNotice('이 항목의 비밀번호는 현재 마스터키로 복호화할 수 없습니다. 수정에서 비밀번호를 다시 입력해 저장해주세요.')
    }
  }

  const revealPasswordTemporarily = (itemId, plainText, durationMs) => {
    setRevealedPasswords((prev) => ({ ...prev, [itemId]: plainText || '-' }))

    if (revealTimersRef.current[itemId]) {
      clearTimeout(revealTimersRef.current[itemId])
    }

    revealTimersRef.current[itemId] = setTimeout(() => {
      setRevealedPasswords((prev) => {
        const next = { ...prev }
        delete next[itemId]
        return next
      })
      delete revealTimersRef.current[itemId]
    }, durationMs)
  }

  const copyTextToClipboard = async (text) => {
    const value = String(text ?? '')
    if (!value) {
      setNotice('복사할 값이 없습니다.')
      return false
    }

    try {
      await navigator.clipboard.writeText(value)
      return true
    } catch {
      setNotice('클립보드 복사에 실패했습니다. 브라우저 권한을 확인해주세요.')
      return false
    }
  }

  const onCopyHost = async (item) => {
    const ok = await copyTextToClipboard(item.host)
    if (!ok) return
    setNotice('호스트를 클립보드에 복사했습니다.')
    showActionToast('호스트 복사 완료')
  }

  const onCopyUsername = async (item) => {
    const ok = await copyTextToClipboard(item.username)
    if (!ok) return
    setNotice('계정을 클립보드에 복사했습니다.')
    showActionToast('계정 복사 완료')
  }

  const onCopyPassword = async (item) => {
    if (!item.password) {
      setNotice('복사할 비밀번호가 없습니다.')
      return
    }
    if (undecryptablePasswordIds[item.id]) {
      setNotice('이 항목의 비밀번호는 현재 마스터키로 복호화할 수 없습니다. 수정에서 비밀번호를 다시 입력해 저장해주세요.')
      return
    }

    try {
      const plain = await decryptPassword(item.password, activeMasterKey)
      const ok = await copyTextToClipboard(plain)
      if (!ok) return
      revealPasswordTemporarily(item.id, plain, COPY_REVEAL_MS)
      setNotice('비밀번호를 클립보드에 복사하고, 5초 동안 화면에 표시 합니다.')
      showActionToast('비밀번호 복사 완료')
    } catch {
      setNotice('이 항목의 비밀번호는 현재 마스터키로 복호화할 수 없습니다. 수정에서 비밀번호를 다시 입력해 저장해주세요.')
    }
  }

  const passwordLabel = (item) => {
    if (!item.password) return '-'
    if (undecryptablePasswordIds[item.id]) return '재설정 필요'
    if (revealedPasswords[item.id]) return revealedPasswords[item.id]
    return '••••••••'
  }

  const getNoticeTone = (message) => {
    const text = String(message || '')
    if (!text) return 'info'

    // Match explicit failure phrases first so success messages containing
    // words like "암호화" are not incorrectly treated as errors.
    if (/실패|불가|오류|권한|제한|만료|없습니다|복호화할 수 없습니다|암호화에 실패/.test(text)) {
      return 'error'
    }

    if (/취소|체크|확인해주세요|다시 시도|감지/.test(text)) {
      return 'warn'
    }

    if (/완료|저장했습니다|생성했습니다|다운로드했습니다|복사했습니다|병합/.test(text)) {
      return 'success'
    }

    return 'info'
  }

  const runExcelDownload = async (exportMasterKey, options = {}) => {
    const { resetCredentials = false } = options
    const selectedIdSet = getSelectedIdSet()
    const selectedItems = items.filter((item) => selectedIdSet.has(item.id))

    if (!selectedItems.length) {
      openInfoModal('내보낼 항목을 먼저 체크해주세요.')
      return
    }

    const hasUndecryptableSelected = selectedItems.some((item) => undecryptablePasswordIds[item.id])
    if (!resetCredentials && hasUndecryptableSelected) {
      setNotice('선택한 항목 중 현재 마스터키로 복호화할 수 없는 비밀번호가 있습니다. 비밀번호를 수정/저장 후 다시 시도해주세요.')
      return
    }

    try {
      const exportItems = resetCredentials
        ? selectedItems.map((item) => ({
          ...item,
          username: 'init',
          password: 'init',
        }))
        : await convertItemPasswordsToKey(
          selectedItems,
          activeMasterKey,
          exportMasterKey,
        )

      const exportRows = exportItems.map((item) => ({
        그룹: item.group || '',
        이름: item.name || '',
        환경: item.environment || '',
        호스트: item.host || '',
        포트: item.port || '',
        계정: item.username || '',
        비밀번호: item.password || '',
        구분: item.database || '',
        메모: item.memo || '',
      }))

      const worksheet = XLSX.utils.json_to_sheet(exportRows)
      worksheet['!cols'] = [
        { wch: 14 },
        { wch: 18 },
        { wch: 10 },
        { wch: 36 },
        { wch: 10 },
        { wch: 16 },
        { wch: 42 },
        { wch: 16 },
        { wch: 40 },
      ]

      const workbook = XLSX.utils.book_new()
      XLSX.utils.book_append_sheet(workbook, worksheet, '접속정보')

      const fileName = `server-access-list-${new Date().toISOString().slice(0, 10)}.xlsx`
      XLSX.writeFile(workbook, fileName, { compression: true })
      setNotice(
        resetCredentials
          ? '계정/비밀번호를 init으로 초기화한 엑셀 파일을 다운로드했습니다.'
          : '엑셀 파일을 다운로드했습니다.',
      )
    } catch {
      setNotice('엑셀 다운로드에 실패했습니다. 잠시 후 다시 시도해주세요.')
    }
  }

  const onDownloadExcel = () => {
    if (getSelectedIdSet().size === 0) {
      openInfoModal('내보낼 항목을 먼저 체크해주세요.')
      return
    }
    setIsExportCapsLockOn(false)
    setIsExportKoreanInputDetected(false)
    setExcelExportPrompt({ open: true, masterKey: '', error: '', resetCredentials: false })
  }

  const onCancelExcelDownload = () => {
    setIsExportCapsLockOn(false)
    setIsExportKoreanInputDetected(false)
    setExcelExportPrompt({ open: false, masterKey: '', error: '', resetCredentials: false })
  }

  const onChangeExcelExportMasterKey = (event) => {
    const { value } = event.target
    const hasHangul = /[ㄱ-ㅎㅏ-ㅣ가-힣]/.test(value)
    setIsExportKoreanInputDetected(hasHangul)

    const validationError = getMasterKeyValidationError(value)
    setExcelExportPrompt((prev) => ({
      ...prev,
      masterKey: value,
      error: value && validationError ? validationError : '',
    }))
  }

  const onExcelExportMasterKeyKeyDown = (event) => {
    if (typeof event.getModifierState === 'function') {
      setIsExportCapsLockOn(event.getModifierState('CapsLock'))
    }

    if (event.key === 'Process') {
      setIsExportKoreanInputDetected(true)
    }

    if (event.key !== 'Enter') return
    event.preventDefault()
    onConfirmExcelDownload()
  }

  const onExcelExportMasterKeyKeyUp = (event) => {
    if (typeof event.getModifierState === 'function') {
      setIsExportCapsLockOn(event.getModifierState('CapsLock'))
    }
  }

  const onConfirmExcelDownload = async () => {
    const exportMasterKey = excelExportPrompt.masterKey
    const shouldResetCredentials = excelExportPrompt.resetCredentials
    if (!shouldResetCredentials) {
      const validationError = getMasterKeyValidationError(exportMasterKey)
      if (validationError) {
        setExcelExportPrompt((prev) => ({ ...prev, error: validationError }))
        return
      }
    }

    setIsExportCapsLockOn(false)
    setIsExportKoreanInputDetected(false)
    setExcelExportPrompt({ open: false, masterKey: '', error: '', resetCredentials: false })
    await runExcelDownload(shouldResetCredentials ? '' : exportMasterKey, { resetCredentials: shouldResetCredentials })
  }

  const columns = useMemo(() => ([
    {
      field: 'actions',
      headerName: '작업',
      minWidth: 52,
      width: 52,
      maxWidth: 52,
      flex: 0,
      align: 'center',
      headerAlign: 'center',
      sortable: false,
      filterable: false,
      renderCell: (params) => {
        const item = params.row
        return (
          <div className="row-actions-table">
            <button
              type="button"
              className="ghost icon-btn icon-btn-small"
              onClick={(event) => {
                event.stopPropagation()
                onEdit(item)
              }}
              title="수정"
              aria-label="수정"
            >
              <FaPen aria-hidden="true" />
            </button>
          </div>
        )
      },
    },
    {
      field: 'group',
      headerName: '그룹',
      minWidth: 100,
      flex: 0.7,
      valueGetter: (value) => value || '-',
    },
    {
      field: 'name',
      headerName: '이름',
      minWidth: 130,
      flex: 0.9,
    },
    {
      field: 'environment',
      headerName: '환경',
      minWidth: 100,
      flex: 0.7,
      renderCell: (params) => (
        <div className="env-cell">
          <span className={`env ${(params.value || 'ETC').toLowerCase()}`}>{params.value || 'ETC'}</span>
        </div>
      ),
    },
    {
      field: 'host',
      headerName: '호스트',
      minWidth: 220,
      flex: 1.3,
      renderCell: (params) => {
        const item = params.row
        return (
          <div className="host-cell">
            {isWebUrl(item.host) ? (
              <a
                href={item.host.trim()}
                target="_blank"
                rel="noopener noreferrer"
                className="host-link"
                onClick={(event) => event.stopPropagation()}
              >
                {item.host}
              </a>
            ) : (
              <span>{item.host || '-'}</span>
            )}
            <button
              type="button"
              className="ghost copy-btn icon-btn icon-btn-small"
              onClick={(event) => {
                event.stopPropagation()
                onCopyHost(item)
              }}
              disabled={!item.host}
              title="호스트 복사"
              aria-label="호스트 복사"
            >
              <FaCopy aria-hidden="true" />
            </button>
          </div>
        )
      },
    },
    {
      field: 'port',
      headerName: '포트',
      minWidth: 90,
      flex: 0.5,
      valueGetter: (value) => value || '-',
    },
    {
      field: 'username',
      headerName: '계정',
      minWidth: 120,
      flex: 0.8,
      sortable: false,
      renderCell: (params) => {
        const item = params.row
        return (
          <div className="host-cell">
            <span>{item.username || '-'}</span>
            <button
              type="button"
              className="ghost copy-btn icon-btn icon-btn-small"
              onClick={(event) => {
                event.stopPropagation()
                onCopyUsername(item)
              }}
              disabled={!item.username}
              title="계정 복사"
              aria-label="계정 복사"
            >
              <FaCopy aria-hidden="true" />
            </button>
          </div>
        )
      },
    },
    {
      field: 'passwordAction',
      headerName: '비밀번호',
      minWidth: 180,
      flex: 1.1,
      sortable: false,
      filterable: false,
      renderCell: (params) => {
        const item = params.row
        return (
          <div className="password-cell">
            <span>{passwordLabel(item)}</span>
            <button
              type="button"
              className="ghost copy-btn icon-btn icon-btn-small"
              onClick={(event) => {
                event.stopPropagation()
                onCopyPassword(item)
              }}
              disabled={!item.password || undecryptablePasswordIds[item.id]}
              title={undecryptablePasswordIds[item.id] ? '현재 마스터키로 복호화 불가' : '비밀번호 복사'}
              aria-label={undecryptablePasswordIds[item.id] ? '현재 마스터키로 복호화 불가' : '비밀번호 복사'}
            >
              <FaCopy aria-hidden="true" />
            </button>
            <button
              type="button"
              className="ghost password-btn icon-btn icon-btn-small"
              onClick={(event) => {
                event.stopPropagation()
                onToggleReveal(item)
              }}
              disabled={!item.password || undecryptablePasswordIds[item.id]}
              title={undecryptablePasswordIds[item.id]
                ? '현재 마스터키로 복호화 불가'
                : (revealedPasswords[item.id] ? '비밀번호 숨김' : '비밀번호 보기')}
              aria-label={undecryptablePasswordIds[item.id]
                ? '현재 마스터키로 복호화 불가'
                : (revealedPasswords[item.id] ? '비밀번호 숨김' : '비밀번호 보기')}
            >
              {revealedPasswords[item.id] ? (
                <FaEyeSlash aria-hidden="true" />
              ) : (
                <FaEye aria-hidden="true" />
              )}
            </button>
          </div>
        )
      },
    },
    {
      field: 'database',
      headerName: '구분',
      minWidth: 130,
      flex: 0.9,
      valueGetter: (value) => value || '-',
    },
    {
      field: 'memo',
      headerName: '메모',
      minWidth: 180,
      flex: 1.3,
      valueGetter: (value) => value || '-',
      renderCell: (params) => (
        <Tooltip
          title={(
            <span style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
              {params.row.memo || '-'}
            </span>
          )}
          arrow
          placement="top-start"
          enterDelay={200}
          slotProps={{
            tooltip: {
              sx: {
                maxWidth: 560,
                fontSize: '0.92rem',
                lineHeight: 1.45,
                p: 1.2,
              },
            },
          }}
        >
          <span className="memo-cell">{params.row.memo || '-'}</span>
        </Tooltip>
      ),
    },
  ]), [revealedPasswords, undecryptablePasswordIds])

  if (!isUnlocked) {
    return (
      <main className="page auth-page">
        <section className="auth-card">
          <p className="eyebrow">Server Access Vault</p>
          <div className="auth-title-row">
            <h1>마스터키 인증</h1>
            <span className="auth-version-inline">v{APP_VERSION}</span>
          </div>
          <section className="auth-guide" aria-label="마스터키 인증 안내">
            <h3>안내</h3>
            <ul>
              <li>마스터키는 최소 7자리 이상이며 영문/숫자/특수문자를 모두 포함해야 합니다.</li>
              <li>입력한 마스터키는 현재 세션 메모리에서만 사용되며 저장하지 않습니다.</li>
              <li>마스터키를 분실하면 데이터 복구가 불가능합니다.</li>
              <li>최초 인증 시에만 로컬 폴더를 선택하며, 이후에는 같은 폴더의 server-access-items.json을 계속 사용합니다.</li>
              <li>저장 경로 변경은 가능하지만 기존 사용하던 파일은 자동으로 이동되진 않습니다. 기존 파일 필요시 변경된 폴더로 파일 이동</li>
              <li>저장소 파일이 없으면 현재 마스터키로 새 암호화 파일을 생성합니다.</li>
              <li>기존 파일의 마스터키가 다르면 새 파일 생성 여부를 확인한 뒤 진행합니다.</li>
              <li>HTTPS + Chrome/Edge에서는 로컬 폴더 파일을 직접 사용합니다. 그 외 브라우저에서는 localStorage 폴백 모드로 동작합니다.</li>
            </ul>
          </section>
          <div className="auth-form" role="form" aria-label="마스터키 인증" autoComplete="off">
            <input type="text" name="username" autoComplete="username" tabIndex={-1} hidden readOnly value="" />
            <input type="text" name="password" autoComplete="off" tabIndex={-1} hidden readOnly value="" />
            <label>
              <input
                type="text"
                name="masterKey"
                className="masterkey-masked-input"
                value={authForm.masterKey}
                onChange={onChangeMasterKey}
                onKeyDown={onAuthKeyDown}
                onKeyUp={updateCapsLockState}
                placeholder="마스터키 입력"
                minLength={MASTER_KEY_MIN_LENGTH}
                pattern="[A-Za-z0-9!@#$%^&*()_+\-=[\]{};':&quot;,.<>/?\\|~]+"
                autoComplete="off"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
              />
            </label>

            <label className="auth-option">
              <input
                type="checkbox"
                checked={changeDataFolderOnUnlock}
                onChange={(event) => setChangeDataFolderOnUnlock(event.target.checked)}
                disabled={!supportsClientFileAccess()}
              />
              경로 변경 (데이터 파일 저장 위치 변경시 선택)
            </label>

            {isKoreanInputDetected && (
              <p className="auth-error">한글 입력이 감지되었습니다. 영문(ENG)으로 변경한 뒤 다시 입력해주세요.</p>
            )}

            {isCapsLockOn && (
              <p className="auth-hint">CapsLock이 켜져 있습니다.</p>
            )}

            {authError && <p className="auth-error">{authError}</p>}

            <button type="button" className="primary auth-submit" onClick={onUnlock}>인증</button>

            <button
              type="button"
              className="ghost action-btn"
              onClick={onDownloadOfflineExeZip}
              title="오프라인 설치 및 실행 파일 다운로드"
              aria-label="오프라인 설치 및 실행 파일 다운로드"
            >
              <FaDownload aria-hidden="true" />
              <span>오프라인 설치 및 실행 파일</span>
            </button>
            
            <p className="auth-sub">현재 배포본: {offlineZipFileName || '없음 (배포 파일 생성 후 표시)'}</p>

          </div>
        </section>

        {recoveryPrompt.open && (
          <div className="modal-backdrop" role="presentation">
            <section className="modal-card" role="dialog" aria-modal="true" aria-labelledby="recovery-dialog-title">
              <h3 id="recovery-dialog-title">저장소 복호화 실패</h3>
              <p className="recovery-message">{recoveryPrompt.message}</p>
              <div className="modal-actions">
                <button type="button" className="ghost" onClick={onCancelRecoveryPrompt}>취소</button>
                <button type="button" className="primary" onClick={onConfirmCreateNewStorage}>새 JSON 생성</button>
              </div>
            </section>
          </div>
        )}

        {initPrompt.open && (
          <div className="modal-backdrop" role="presentation">
            <section className="modal-card" role="dialog" aria-modal="true" aria-labelledby="init-dialog-title">
              <h3 id="init-dialog-title">JSON 저장소 생성 확인</h3>
              <p className="recovery-message">{initPrompt.message}</p>
              <div className="modal-actions">
                <button type="button" className="ghost" onClick={onCancelInitPrompt}>취소</button>
                <button type="button" className="primary" onClick={onConfirmInitPrompt}>생성</button>
              </div>
            </section>
          </div>
        )}
      </main>
    )
  }

  return (
    <main className="page">
      <section className="hero-wrap">
        <header className="hero">
          <p className="eyebrow">Server Access Vault</p>
          <h1>접속정보 관리</h1>
          <p className="sub">
            접속 정보를 한곳에서 정리하고 검색하세요.
          </p>
          <p className="sub">버전: v{APP_VERSION}</p>
        </header>
        <button type="button" className="ghost action-btn logout-btn" onClick={onLock}>
          <FaRightFromBracket aria-hidden="true" />
          <span>로그아웃</span>
        </button>
      </section>

      <section className="panel form-panel">
        <div className="form-panel-head">
          <h2>{form.id ? '접속정보 수정' : '접속정보 등록'}</h2>
          <div className="form-panel-actions">
            <button
              type="button"
              className="ghost action-btn"
              onClick={() => setIsFormOpen((prev) => !prev)}
              aria-expanded={isFormOpen}
              aria-label={isFormOpen ? '등록 폼 접기' : '등록 폼 펼치기'}
            >
              {isFormOpen ? <FaChevronUp aria-hidden="true" /> : <FaChevronDown aria-hidden="true" />}
              <span>{isFormOpen ? '등록 폼 접기' : '등록 폼 펼치기'}</span>
            </button>
          </div>
        </div>

        {isFormOpen ? (
          <form onSubmit={onSubmit} className="form-grid" autoComplete="off">
            <label>
              그룹
              <input ref={formFirstInputRef} name="group" value={form.group} onChange={onChangeField} placeholder="예: 수입" />
            </label>
            <label>
              이름*
              <input name="name" value={form.name} onChange={onChangeField} placeholder="예: WAS03" />
            </label>
            <label>
              환경
              <select name="environment" value={form.environment} onChange={onChangeField}>
                <option>DEV</option>
                <option>STG</option>
                <option>PROD</option>
                <option>ETC</option>
              </select>
            </label>
            <label>
              호스트/IP*
              <input name="host" value={form.host} onChange={onChangeField} placeholder="192.168.0.10" autoComplete="off" />
            </label>
            <label>
              포트
              <input name="port" value={form.port} onChange={onChangeField} placeholder="포트" autoComplete="off" />
            </label>
            <label>
              계정*
              <input name="username" value={form.username} onChange={onChangeField} placeholder="계정" autoComplete="off" />
            </label>
            <label>
              비밀번호
              <input
                type="password"
                name="password"
                value={form.password}
                onChange={onChangeField}
                onKeyDown={onPasswordFieldKeyDown}
                onKeyUp={onPasswordFieldKeyUp}
                placeholder="비밀번호"
                autoComplete="new-password"
              />
              {isFormPasswordKoreanInputDetected && (
                <p className="auth-error">한글 입력이 감지되었습니다. 영문(ENG)으로 변경한 뒤 다시 입력해주세요.</p>
              )}
              {isFormPasswordCapsLockOn && (
                <p className="auth-hint">CapsLock이 켜져 있습니다.</p>
              )}
            </label>
            <label>
              구분
              <input name="database" value={form.database} onChange={onChangeField} placeholder="구분" autoComplete="off" />
            </label>
            <label className="wide">
              메모
              <textarea name="memo" value={form.memo} onChange={onChangeField} rows={3} placeholder="접속 경로, 주의사항 등" />
            </label>

            <div className="actions wide">
              <button type="submit" className="ghost action-btn">
                {form.id ? <FaPen aria-hidden="true" /> : <FaPlus aria-hidden="true" />}
                <span>{form.id ? '수정 저장' : '등록'}</span>
              </button>
              <button type="button" className="ghost action-btn" onClick={resetForm}>
                <FaRotateLeft aria-hidden="true" />
                <span>초기화</span>
              </button>
            </div>
          </form>
        ) : (
          <p className="form-collapsed-hint">기본 상태는 접힘입니다. 리스트에서 수정을 누르면 자동으로 펼쳐집니다.</p>
        )}
      </section>

      <section className="panel list-panel">
        <div className="toolbar">
          <div className="toolbar-head">
            <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
              <h2>접속정보 목록 ({filteredItems.length})</h2>
              <span className={`vault-state ${isSyncing ? 'open' : 'close'}`}>
                {isSyncing ? '파일 저장 중' : '파일 동기화됨'}
              </span>
            </div>
            <div className="toolbar-actions">
              <button
                type="button"
                className="ghost action-btn"
                onClick={onDownloadExcel}
                title="엑셀 다운로드"
                aria-label="엑셀 다운로드"
              >
                <FaFileExcel aria-hidden="true" />
                <span>엑셀 다운로드</span>
              </button>
              <button
                type="button"
                className="ghost action-btn"
                onClick={onImportExcelClick}
                title="엑셀 가져오기"
                aria-label="엑셀 가져오기"
              >
                <FaFileImport aria-hidden="true" />
                <span>엑셀 가져오기</span>
              </button>
              <button
                type="button"
                className="ghost action-btn"
                onClick={onOpenExportPrompt}
                title="JSON 내보내기"
                aria-label="JSON 내보내기"
              >
                <FaDownload aria-hidden="true" />
                <span>JSON 내보내기</span>
              </button>
              <button
                type="button"
                className="ghost action-btn"
                onClick={onImportJsonClick}
                title="JSON 가져오기"
                aria-label="JSON 가져오기"
              >
                <FaFileImport aria-hidden="true" />
                <span>JSON 가져오기</span>
              </button>
              <button
                type="button"
                className="danger action-btn"
                onClick={onDeleteSelected}
                title="삭제"
                aria-label="삭제"
              >
                <FaTrash aria-hidden="true" />
                <span>삭제</span>
              </button>              
            </div>
          </div>

          <div className="toolbar-search">
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
              <p className="toolbar-search-label">검색 조건</p>
              <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                <button
                  type="button"
                  className="ghost action-btn"
                  onClick={() => setIsExcludeFiltersOpen(!isExcludeFiltersOpen)}
                  title={isExcludeFiltersOpen ? '제외 조건 접기' : '제외 조건 펼치기'}
                  aria-label={isExcludeFiltersOpen ? '제외 조건 접기' : '제외 조건 펼치기'}
                >
                  {isExcludeFiltersOpen ? <FaChevronUp aria-hidden="true" /> : <FaChevronDown aria-hidden="true" />}
                  <span>제외조건</span>
                </button>
                <button
                  type="button"
                  className="ghost action-btn"
                  onClick={() => setFilters(initialFilters)}
                  title="조건 초기화"
                >
                  <FaRotateLeft aria-hidden="true" />
                  <span>초기화</span>
                </button>
              </div>
            </div>
            <div className="filter-grid">
              <input
                name="group"
                value={filters.group}
                onChange={onChangeFilter}
                placeholder="그룹 조건"
              />
              <input
                name="name"
                value={filters.name}
                onChange={onChangeFilter}
                placeholder="이름 조건"
              />
              <select
                name="environment"
                value={filters.environment}
                onChange={onChangeFilter}
              >
                <option value="">환경 전체</option>
                <option value="DEV">DEV</option>
                <option value="STG">STG</option>
                <option value="PROD">PROD</option>
                <option value="ETC">ETC</option>
              </select>
              <input
                name="host"
                value={filters.host}
                onChange={onChangeFilter}
                placeholder="호스트 조건"
              />
              <input
                name="database"
                value={filters.database}
                onChange={onChangeFilter}
                placeholder="구분 조건"
              />
            </div>
            {isExcludeFiltersOpen && (
            <div className="filter-grid" style={{ marginTop: '10px' }}>              
              <input
                name="excludeGroup"
                value={filters.excludeGroup}
                onChange={onChangeFilter}
                placeholder="그룹 제외"
              />
              <input
                name="excludeName"
                value={filters.excludeName}
                onChange={onChangeFilter}
                placeholder="이름 제외"
              />
              <select
                name="excludeEnvironment"
                value={filters.excludeEnvironment}
                onChange={onChangeFilter}
              >
                <option value="">환경 제외</option>
                <option value="DEV">DEV</option>
                <option value="STG">STG</option>
                <option value="PROD">PROD</option>
                <option value="ETC">ETC</option>
              </select>
              <input
                name="excludeHost"
                value={filters.excludeHost}
                onChange={onChangeFilter}
                placeholder="호스트 제외"
              />
              <input
                name="excludeDatabase"
                value={filters.excludeDatabase}
                onChange={onChangeFilter}
                placeholder="구분 제외"
              />
            </div>
            )}
            <input
              ref={excelFileInputRef}
              type="file"
              accept="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,.xlsx,application/vnd.ms-excel,.xls"
              onChange={onImportExcelFile}
              hidden
            />
            <input
              ref={jsonFileInputRef}
              type="file"
              accept="application/json,.json"
              onChange={onImportJsonFile}
              hidden
            />
          </div>
        </div>

        {notice && <p className={`notice notice-${getNoticeTone(notice)}`}>{notice}</p>}

        <div className="excel-wrap data-grid-wrap">
          <DataGrid
            rows={filteredItems}
            columns={columns}
            checkboxSelection
            pinnedColumns={{ left: ['actions'] }}
            disableRowSelectionOnClick
            disableColumnFilter
            rowSelectionModel={rowSelectionModel}
            onRowSelectionModelChange={(newSelectionModel) => {
              if (Array.isArray(newSelectionModel)) {
                setRowSelectionModel({
                  type: 'include',
                  ids: new Set(newSelectionModel),
                })
                return
              }

              if (newSelectionModel?.type === 'exclude' && newSelectionModel.ids instanceof Set) {
                // DataGrid may emit exclude-model for "select all"; normalize to visible include IDs.
                const visibleSelectedIds = filteredItems
                  .filter((item) => !newSelectionModel.ids.has(item.id))
                  .map((item) => item.id)

                setRowSelectionModel({
                  type: 'include',
                  ids: new Set(visibleSelectedIds),
                })
                return
              }

              if (newSelectionModel?.type === 'include' && newSelectionModel.ids instanceof Set) {
                setRowSelectionModel({
                  type: 'include',
                  ids: new Set(newSelectionModel.ids),
                })
                return
              }

              setRowSelectionModel({ type: 'include', ids: new Set() })
            }}
            pageSizeOptions={[25, 50, 100]}
            paginationModel={paginationModel}
            onPaginationModelChange={setPaginationModel}
            initialState={{
              pinnedColumns: {
                left: ['actions'],
              },
            }}
            sx={{
              border: 'none',
              height: '100%',
              '& .MuiDataGrid-columnHeaders': {
                background: 'linear-gradient(180deg, #eef8f7 0%, #e4f1ef 100%)',
                borderBottom: '2px solid #97bdb8',
                boxShadow: 'inset 0 -1px 0 #c2ddda',
              },
              '& .MuiDataGrid-columnHeaderTitle': {
                fontWeight: 700,
                color: '#1d4a52',
              },
              '& .MuiDataGrid-cell': {
                borderBottom: '1px solid #e1efed',
                backgroundColor: '#ffffff',
              },
              '& .MuiDataGrid-row:nth-of-type(even) .MuiDataGrid-cell': {
                backgroundColor: '#fbfefe',
              },
              '& .MuiDataGrid-row:hover': {
                backgroundColor: '#f2fbfa',
              },
              '& .MuiDataGrid-pinnedColumns': {
                backgroundColor: '#ffffff',
              },
              '& .MuiDataGrid-pinnedColumnHeaders': {
                background: 'linear-gradient(180deg, #eef8f7 0%, #e4f1ef 100%)',
                borderRight: '1px solid #d8e7e5',
              },
              '& .MuiDataGrid-cell--pinnedLeft': {
                borderRight: '1px solid #d8e7e5',
              },
              '& .MuiDataGrid-cell:focus, & .MuiDataGrid-cell:focus-within, & .MuiDataGrid-columnHeader:focus, & .MuiDataGrid-columnHeader:focus-within': {
                outline: 'none',
              },
              '& .MuiDataGrid-footerContainer': {
                borderTop: '1px solid #d8e7e5',
              },
            }}
          />
        </div>
      </section>

      {pendingImport.open && (
        <div className="modal-backdrop" role="presentation">
          <section className="modal-card" role="dialog" aria-modal="true" aria-labelledby="import-dialog-title">
            <h3 id="import-dialog-title">가져오기 확인</h3>
            <p>
              현재 목록을 유지한 채 가져오기를 진행합니다.
              <br />
              같은 계정+호스트는 업데이트되고, 신규 조합은 추가됩니다.
              <br />
              파일: {pendingImport.fileName}
            </p>
            <label>
              가져오기 마스터키
              <input
                type="text"
                className="masterkey-masked-input"
                value={pendingImport.masterKey}
                onChange={onChangeImportMasterKey}
                onKeyDown={onImportMasterKeyKeyDown}
                onKeyUp={onImportMasterKeyKeyUp}
                placeholder="가져올 JSON의 마스터키"
                minLength={MASTER_KEY_MIN_LENGTH}
                pattern="[A-Za-z0-9!@#$%^&*()_+\-=[\]{};':&quot;,.<>/?\\|~]+"
                autoFocus
                autoComplete="off"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
              />
            </label>
            {isImportKoreanInputDetected && (
              <p className="auth-error">한글 입력이 감지되었습니다. 영문(ENG)으로 변경한 뒤 다시 입력해주세요.</p>
            )}
            {isImportCapsLockOn && (
              <p className="auth-hint">CapsLock이 켜져 있습니다.</p>
            )}
            {pendingImport.error && <p className="auth-error">{pendingImport.error}</p>}
            <div className="modal-actions">
              <button type="button" className="ghost action-btn" onClick={onCancelImport}>
                <FaRotateLeft aria-hidden="true" />
                <span>취소</span>
              </button>
              <button type="button" className="primary action-btn" onClick={onConfirmImport}>
                <FaFileImport aria-hidden="true" />
                <span>JSON 가져오기</span>
              </button>
            </div>
          </section>
        </div>
      )}

      {pendingExcelImport.open && (
        <div className="modal-backdrop" role="presentation">
          <section className="modal-card" role="dialog" aria-modal="true" aria-labelledby="excel-import-dialog-title">
            <h3 id="excel-import-dialog-title">엑셀 가져오기 확인</h3>
            {pendingExcelImport.requiresMasterKey ? (
              <>
                <p>
                  엑셀 비밀번호 컬럼은 가져오기 마스터키로 복호화 후,
                  <br />
                  현재 저장소 마스터키로 다시 암호화해 저장합니다.
                  <br />
                  파일: {pendingExcelImport.fileName}
                </p>
                <label>
                  엑셀 가져오기 마스터키
                  <input
                    type="text"
                    className="masterkey-masked-input"
                    value={pendingExcelImport.masterKey}
                    onChange={onChangeExcelImportMasterKey}
                    onKeyDown={onImportMasterKeyKeyDown}
                    onKeyUp={onImportMasterKeyKeyUp}
                    placeholder="엑셀 비밀번호 복호화용 마스터키"
                    minLength={MASTER_KEY_MIN_LENGTH}
                    pattern="[A-Za-z0-9!@#$%^&*()_+\-=[\]{};':&quot;,.<>/?\\|~]+"
                    autoFocus
                    autoComplete="off"
                    autoCapitalize="off"
                    autoCorrect="off"
                    spellCheck={false}
                  />
                </label>
                {isImportKoreanInputDetected && (
                  <p className="auth-error">한글 입력이 감지되었습니다. 영문(ENG)으로 변경한 뒤 다시 입력해주세요.</p>
                )}
                {isImportCapsLockOn && (
                  <p className="auth-hint">CapsLock이 켜져 있습니다.</p>
                )}
              </>
            ) : (
              <p>
                엑셀 비밀번호 컬럼에 암호화 데이터가 없어 마스터키 입력 없이 가져옵니다.
                <br />
                파일: {pendingExcelImport.fileName}
              </p>
            )}
            {pendingExcelImport.error && <p className="auth-error">{pendingExcelImport.error}</p>}
            <div className="modal-actions">
              <button type="button" className="ghost action-btn" onClick={onCancelExcelImport}>
                <FaRotateLeft aria-hidden="true" />
                <span>취소</span>
              </button>
              <button type="button" className="primary action-btn" onClick={onConfirmExcelImport}>
                <FaFileImport aria-hidden="true" />
                <span>엑셀 가져오기</span>
              </button>
            </div>
          </section>
        </div>
      )}

      {exportPrompt.open && (
        <div className="modal-backdrop" role="presentation">
          <section className="modal-card" role="dialog" aria-modal="true" aria-labelledby="export-dialog-title">
            <h3 id="export-dialog-title">JSON 내보내기</h3>
            <p>내보낼 JSON에 사용할 마스터키를 입력해주세요.</p>
            <label>
              내보내기 마스터키
              <input
                type="text"
                className="masterkey-masked-input"
                value={exportPrompt.masterKey}
                onChange={onChangeExportMasterKey}
                onKeyDown={onExportMasterKeyKeyDown}
                onKeyUp={onExportMasterKeyKeyUp}
                placeholder="내보내기 마스터키"
                minLength={MASTER_KEY_MIN_LENGTH}
                pattern="[A-Za-z0-9!@#$%^&*()_+\-=[\]{};':&quot;,.<>/?\\|~]+"
                autoFocus
                autoComplete="off"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
              />
            </label>
            <label className="auth-option">
              <input
                type="checkbox"
                checked={exportPrompt.resetCredentials}
                onChange={(event) => {
                  const { checked } = event.target
                  setExportPrompt((prev) => ({ ...prev, resetCredentials: checked }))
                }}
              />
              계정/비밀번호 초기화 (계정: init, 비밀번호: init)
            </label>
            {isExportKoreanInputDetected && (
              <p className="auth-error">한글 입력이 감지되었습니다. 영문(ENG)으로 변경한 뒤 다시 입력해주세요.</p>
            )}
            {isExportCapsLockOn && (
              <p className="auth-hint">CapsLock이 켜져 있습니다.</p>
            )}
            {exportPrompt.error && <p className="auth-error">{exportPrompt.error}</p>}
            <div className="modal-actions">
              <button type="button" className="ghost action-btn" onClick={onCancelExportPrompt}>
                <FaRotateLeft aria-hidden="true" />
                <span>취소</span>
              </button>
              <button type="button" className="primary action-btn" onClick={onConfirmExport}>
                <FaDownload aria-hidden="true" />
                <span>생성</span>
              </button>
            </div>
          </section>
        </div>
      )}

      {excelExportPrompt.open && (
        <div className="modal-backdrop" role="presentation">
          <section className="modal-card" role="dialog" aria-modal="true" aria-labelledby="excel-download-dialog-title">
            <h3 id="excel-download-dialog-title">엑셀 다운로드</h3>
            {excelExportPrompt.resetCredentials ? (
              <p>계정/비밀번호를 init으로 초기화해 엑셀을 다운로드합니다. 마스터키 입력은 생략됩니다.</p>
            ) : (
              <>
                <p>엑셀 비밀번호 컬럼 암호화에 사용할 마스터키를 입력해주세요.</p>
                <p>(비밀번호 컬럼만 암호화 됩니다.)</p>
                <label>
                  엑셀 내보내기 마스터키
                  <input
                    type="text"
                    className="masterkey-masked-input"
                    value={excelExportPrompt.masterKey}
                    onChange={onChangeExcelExportMasterKey}
                    onKeyDown={onExcelExportMasterKeyKeyDown}
                    onKeyUp={onExcelExportMasterKeyKeyUp}
                    placeholder="엑셀 비밀번호 컬럼 암호화용 마스터키"
                    minLength={MASTER_KEY_MIN_LENGTH}
                    pattern="[A-Za-z0-9!@#$%^&*()_+\-=[\]{};':&quot;,.<>/?\\|~]+"
                    autoFocus
                    autoComplete="off"
                    autoCapitalize="off"
                    autoCorrect="off"
                    spellCheck={false}
                  />
                </label>
              </>
            )}
            <label className="auth-option">
              <input
                type="checkbox"
                checked={excelExportPrompt.resetCredentials}
                onChange={(event) => {
                  const { checked } = event.target
                  setExcelExportPrompt((prev) => ({
                    ...prev,
                    resetCredentials: checked,
                    masterKey: checked ? '' : prev.masterKey,
                    error: '',
                  }))
                }}
              />
              계정/비밀번호 초기화 (계정: init, 비밀번호: init)
            </label>
            {!excelExportPrompt.resetCredentials && isExportKoreanInputDetected && (
              <p className="auth-error">한글 입력이 감지되었습니다. 영문(ENG)으로 변경한 뒤 다시 입력해주세요.</p>
            )}
            {!excelExportPrompt.resetCredentials && isExportCapsLockOn && (
              <p className="auth-hint">CapsLock이 켜져 있습니다.</p>
            )}
            {excelExportPrompt.error && <p className="auth-error">{excelExportPrompt.error}</p>}
            <div className="modal-actions">
              <button type="button" className="ghost action-btn" onClick={onCancelExcelDownload}>
                <FaRotateLeft aria-hidden="true" />
                <span>취소</span>
              </button>
              <button type="button" className="primary action-btn" onClick={onConfirmExcelDownload}>
                <FaFileExcel aria-hidden="true" />
                <span>생성</span>
              </button>
            </div>
          </section>
        </div>
      )}

      {actionToast && <div className="action-toast">{actionToast}</div>}

      {infoModal.open && (
        <div className="modal-backdrop" role="presentation">
          <section className="modal-card" role="dialog" aria-modal="true" aria-labelledby="info-modal-title">
            <h3 id="info-modal-title">{infoModal.title}</h3>
            <p>{infoModal.message}</p>
            <div className="modal-actions">
              <button type="button" className="primary" onClick={closeInfoModal}>확인</button>
            </div>
          </section>
        </div>
      )}

      {deleteConfirmModal.open && (
        <div className="modal-backdrop" role="presentation">
          <section className="modal-card" role="dialog" aria-modal="true" aria-labelledby="delete-confirm-dialog-title">
            <h3 id="delete-confirm-dialog-title">삭제 확인</h3>
            <p>
              선택한 {deleteConfirmModal.ids.length}건을 정말 삭제하시겠습니까?
              <br />
              이 작업은 되돌릴 수 없습니다.
            </p>
            <div className="modal-actions">
              <button type="button" className="ghost action-btn" onClick={onCancelDeleteConfirm}>
                <FaRotateLeft aria-hidden="true" />
                <span>취소</span>
              </button>
              <button type="button" className="danger action-btn" onClick={onConfirmDeleteSelected}>
                <FaTrash aria-hidden="true" />
                <span>삭제</span>
              </button>
            </div>
          </section>
        </div>
      )}

      {formErrorModal.open && (
        <div className="modal-backdrop" role="presentation">
          <section className="modal-card" role="dialog" aria-modal="true" aria-labelledby="form-error-dialog-title">
            <h3 id="form-error-dialog-title">등록 오류</h3>
            <p>{formErrorModal.message}</p>
            <div className="modal-actions">
              <button type="button" className="primary" onClick={closeFormErrorModal}>확인</button>
            </div>
          </section>
        </div>
      )}
    </main>
  )
}

export default App
