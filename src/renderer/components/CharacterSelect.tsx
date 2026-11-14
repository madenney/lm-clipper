import { sortedCharacters } from '../../constants/characters'
import type { PlayerInterface } from '../../constants/types'
import { resolveCharacterImage } from '../lib/clipAssets'
import OptionSelect, { type SelectItem } from './OptionSelect'

type Props = Omit<
  React.ComponentProps<typeof OptionSelect>,
  'items' | 'iconFor' | 'noun' | 'variant'
> & { characters?: SelectItem[] }

const iconFor = (id: number) =>
  resolveCharacterImage({
    characterId: id,
    characterColor: 0,
  } as PlayerInterface)

/** Character picker: stock icon + name, single or multi. */
export default function CharacterSelect({
  characters = sortedCharacters as SelectItem[],
  ...rest
}: Props) {
  return (
    <OptionSelect
      // eslint-disable-next-line react/jsx-props-no-spreading
      {...rest}
      items={characters}
      iconFor={iconFor}
      noun="characters"
    />
  )
}
