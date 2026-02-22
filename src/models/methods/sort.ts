export const sortOptions = [
  {
    id: 'chronological',
    shortName: 'chronological',
    requiresParser: false,
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
  {
    id: 'dps',
    shortName: 'damage per second',
    requiresParser: true,
    method: (reverse: boolean) => {
      return (resultA: any, resultB: any) => {
        const movesA = resultA.combo?.moves || []
        const movesB = resultB.combo?.moves || []
        const totalDamageA = movesA.reduce(
          (total: number, move: { damage: number }) => {
            return total + move.damage
          },
          0,
        )
        const totalDamageB = movesB.reduce(
          (total: number, move: { damage: number }) => {
            return total + move.damage
          },
          0,
        )

        const durationA = resultA.endFrame - resultA.startFrame || 1
        const durationB = resultB.endFrame - resultB.startFrame || 1
        const dpsA = totalDamageA / durationA
        const dpsB = totalDamageB / durationB

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
    requiresParser: true,
    method: (reverse: boolean) => {
      return (resultA: any, resultB: any) => {
        const lenA = resultA.combo?.moves?.length || 0
        const lenB = resultB.combo?.moves?.length || 0
        if (reverse) {
          return lenB - lenA
        }
        return lenA - lenB
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
