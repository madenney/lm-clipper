export const shuffleArray = (_array: any[]) => {
  // shallow copy it
  const array = _array.slice(0)
  let currentIndex = array.length
  let temporaryValue
  let randomIndex

  // While there remain elements to shuffle...
  while (currentIndex !== 0) {
    // Pick a remaining element...
    randomIndex = Math.floor(Math.random() * currentIndex)
    currentIndex -= 1

    // And swap it with the current element.
    temporaryValue = array[currentIndex]
    array[currentIndex] = array[randomIndex]
    array[randomIndex] = temporaryValue
  }
  return array
}

export const pad = (num: number, size: number) => {
  let strNum = num.toString()
  while (strNum.length < size) strNum = `0${strNum}`
  return strNum
}

export const asyncForEach = async (array: any[], callback: any) => {
  for (let index = 0; index < array.length; index++) {
    await callback(array[index], index, array)
  }
}

export function getWorkerExecArgv(): string[] | undefined {
  const mode = process.env.LM_CLIPPER_WORKER_TS_NODE
  if (!mode) return undefined
  if (mode === 'esm') return ['--loader', 'ts-node/esm']
  return ['-r', 'ts-node/register/transpile-only']
}
