export const sortOptions = [
  {
    id: 'dps',
    shortName: 'DPS',
    method: (reverse: boolean) => {
      return (resultA: any, resultB: any) => {
        console.log("resultA: ", resultA)
        console.log("resultB: ", resultB)
        const totalDamageA = resultA.combo.moves.reduce((total: number, move) => {
          return total + move.damage
        }, 0)
        const totalDamageB = resultB.combo.moves.reduce((total: number, move) => {
          return total + move.damage
        }, 0)

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
    shortName: '# Moves',
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
    id: 'x',
    shortName: 'x',
    method: (reverse: boolean) => {
      return (resultA: any, resultB: any) => {
        if (reverse) {
          return resultB.x - resultA.x
        }
        return resultA.x - resultB.x
      }
    },
  },
  {
    id: 'absX',
    shortName: 'abs(x)',
    method: (reverse: boolean) => {
      return (resultA: any, resultB: any) => {
        if (reverse) {
          return Math.abs(resultB.x) - Math.abs(resultA.x)
        }
        return Math.abs(resultA.x) - Math.abs(resultB.x)
      }
    },
  },
  {
    id: 'y',
    shortName: 'y',
    method: (reverse: boolean) => {
      return (resultA: any, resultB: any) => {
        if (reverse) {
          return resultB.y - resultA.y
        }
        return resultA.y - resultB.y
      }
    },
  },
]

export const sort = (prevResults, params) => {
  const { sortFunction, reverse } = params
  console.log(params)
  const sortOption = sortOptions.find((s) => s.id === sortFunction)
  if (!sortOption) throw Error('sortOption undefined')
  const copy = prevResults.map((result) => {
    return { ...result }
  })
  console.log(sortOption.method(reverse))
  return copy.sort(sortOption.method(reverse))
}
