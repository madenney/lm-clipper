export const sortOptions = [
  {
    id: 'dps',
    shortName: 'damage per second',
    method: (reverse: boolean) => {
      return (resultA: any, resultB: any) => {
        const totalDamageA = resultA.combo.moves.reduce(
          (total: number, move: { damage: number }) => {
            return total + move.damage
          },
          0,
        )
        const totalDamageB = resultB.combo.moves.reduce(
          (total: number, move: { damage: number }) => {
            return total + move.damage
          },
          0,
        )

        const dpsA = totalDamageA / (resultA.endFrame - resultA.startFrame)
        const dpsB = totalDamageB / (resultB.endFrame - resultB.startFrame)

        if (reverse) {
          return dpsA - dpsB
        }
        return dpsB - dpsA
      }
    },
  },
  {
    id: 'moves',
    shortName: 'number of moves',
    method: (reverse: boolean) => {
      return (resultA: any, resultB: any) => {
        if (reverse) {
          return resultB.combo.moves.length - resultA.combo.moves.length
        }
        return resultA.combo.moves.length - resultB.combo.moves.length
      }
    },
  },
  {
    id: 'chronological',
    shortName: 'chronological',
    method: (reverse: boolean) => {
      return (resultA: any, resultB: any) => {
        const a = resultA.startedAt || 0
        const b = resultB.startedAt || 0
        if (reverse) {
          return b - a
        }
        return a - b
      }
    },
  },
]

export const sort = (prevResults: any[], params: { [key: string]: any }) => {
  const { sortFunction, reverse } = params
  console.log(params)
  const sortOption = sortOptions.find((s) => s.id === sortFunction)
  if (!sortOption) throw Error('sortOption undefined')
  const copy = prevResults.map((result: any) => {
    return { ...result }
  })
  console.log(sortOption.method(reverse))
  return copy.sort(sortOption.method(reverse))
}
