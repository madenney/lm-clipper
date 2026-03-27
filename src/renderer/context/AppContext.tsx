import { createContext, useContext, Dispatch, SetStateAction } from 'react'
import { ConfigInterface, ShallowArchiveInterface } from '../../constants/types'

type ArchiveContextType = {
  archive: ShallowArchiveInterface | null
  setArchive: Dispatch<SetStateAction<ShallowArchiveInterface | null>>
}

type ConfigContextType = {
  config: ConfigInterface
  setConfig: Dispatch<SetStateAction<ConfigInterface | null>>
}

export const ArchiveContext = createContext<ArchiveContextType | null>(null)
export const ConfigContext = createContext<ConfigContextType | null>(null)

export function useArchive(): ArchiveContextType {
  const ctx = useContext(ArchiveContext)
  if (!ctx) throw new Error('useArchive must be used within ArchiveContext')
  return ctx
}

export function useConfig(): ConfigContextType {
  const ctx = useContext(ConfigContext)
  if (!ctx) throw new Error('useConfig must be used within ConfigContext')
  return ctx
}
