import { useState } from 'react'

import { ConfigInterface, CustomGeckoCode } from '../../constants/types'

/**
 * State and handlers for the custom Gecko code list shared by GeckoModal and
 * SettingsModal. `handleChange` persists a config key.
 */
export default function useGeckoCodes(
  config: ConfigInterface,
  handleChange: (_key: string, _value: any) => void,
) {
  const [expandedGeckoIdx, setExpandedGeckoIdx] = useState<number | null>(null)

  function handleAddGeckoCode() {
    const codes = [...(config.customGeckoCodes || [])]
    codes.push({ name: '', code: '', enabled: true })
    handleChange('customGeckoCodes', codes)
    setExpandedGeckoIdx(codes.length - 1)
  }

  function handleRemoveGeckoCode(idx: number) {
    const codes = [...(config.customGeckoCodes || [])]
    codes.splice(idx, 1)
    handleChange('customGeckoCodes', codes)
    if (expandedGeckoIdx === idx) setExpandedGeckoIdx(null)
    else if (expandedGeckoIdx !== null && expandedGeckoIdx > idx)
      setExpandedGeckoIdx(expandedGeckoIdx - 1)
  }

  function handleUpdateGeckoCode(
    idx: number,
    field: keyof CustomGeckoCode,
    value: string | boolean,
  ) {
    const codes = [...(config.customGeckoCodes || [])]
    codes[idx] = { ...codes[idx], [field]: value }
    handleChange('customGeckoCodes', codes)
  }

  return {
    expandedGeckoIdx,
    setExpandedGeckoIdx,
    handleAddGeckoCode,
    handleRemoveGeckoCode,
    handleUpdateGeckoCode,
  }
}
