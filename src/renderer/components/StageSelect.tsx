import { legalStages } from '../../constants/stages'
import { resolveStageImage } from '../lib/clipAssets'
import OptionSelect, { type SelectItem } from './OptionSelect'

type Props = Omit<
  React.ComponentProps<typeof OptionSelect>,
  'items' | 'iconFor' | 'noun' | 'variant'
> & { stages?: SelectItem[] }

const iconFor = (id: number) => resolveStageImage(id)

/** Stage picker: thumbnail + name, single or multi. */
export default function StageSelect({
  stages = legalStages as SelectItem[],
  anyLabel = 'Any stage',
  ...rest
}: Props) {
  return (
    <OptionSelect
      // eslint-disable-next-line react/jsx-props-no-spreading
      {...rest}
      anyLabel={anyLabel}
      items={stages}
      iconFor={iconFor}
      noun="stages"
      variant="stage"
    />
  )
}
