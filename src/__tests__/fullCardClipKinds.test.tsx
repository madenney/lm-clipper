/**
 * The single view shows the clip that is in it, whatever kind of clip: an
 * edgeguard (or highlight, pressure…) plays in the replay player on its own
 * frames, like a combo. Only a whole game gets the game flow instead.
 */
import '@testing-library/jest-dom'
import { render, screen } from '@testing-library/react'

import { FullCard } from '../renderer/components/Clip/FullCard'

const watched: { path: string; startFrame: number; endFrame: number }[] = []
const tracks: { startFrame: number; endFrame: number }[] = []

jest.mock('../renderer/components/Clip/ClipWatch', () => ({
  __esModule: true,
  default: (props: { path: string; startFrame: number; endFrame: number }) => {
    watched.push(props)
    return <div data-testid="watch" />
  },
}))
jest.mock('../renderer/ipcBridge', () => ({
  __esModule: true,
  default: {
    getClipTrack: (p: { startFrame: number; endFrame: number }) =>
      tracks.push(p),
    openFolder: jest.fn(),
  },
}))
jest.mock('../renderer/components/Clip/ReplayInfoPanel', () => ({
  __esModule: true,
  default: () => null,
}))

const player = (playerIndex: number, port: number) => ({
  playerIndex,
  port,
  characterId: 20,
  displayName: `P${port}`,
})

beforeEach(() => {
  watched.length = 0
  tracks.length = 0
})

const views = () => ({
  watch: screen.queryByTestId('watch'),
  flow: screen.queryByText('Game flow'),
})

describe('the single view', () => {
  it('plays an edgeguard clip on its own frames', () => {
    render(
      <FullCard
        data={
          {
            path: '/r/game.slp',
            stage: 8,
            startFrame: 4000,
            endFrame: 4300,
            comboer: player(0, 1),
            comboee: player(1, 2),
            edgeguardScore: 7,
            edgeguardMetrics: { score: 7, hits: 2 },
          } as any
        }
      />,
    )
    expect(views().watch).toBeInTheDocument()
    expect(views().flow).toBeNull()
    expect(watched[0]).toMatchObject({
      path: '/r/game.slp',
      startFrame: 4000,
      endFrame: 4300,
    })
    // The map reads the clip's frames, not the whole game.
    expect(tracks[0]).toMatchObject({ startFrame: 4000, endFrame: 4300 })
    // No combo data: no hit list.
    expect(screen.queryByText(/^Hits/)).toBeNull()
  })

  it('plays a combo clip, as before', () => {
    render(
      <FullCard
        data={
          {
            path: '/r/game.slp',
            stage: 8,
            startFrame: 1000,
            endFrame: 1200,
            comboer: player(0, 1),
            comboee: player(1, 2),
            combo: {
              startPercent: 0,
              endPercent: 60,
              didKill: true,
              moves: [
                {
                  playerIndex: 0,
                  frame: 1010,
                  moveId: 17,
                  hitCount: 1,
                  damage: 12,
                },
              ],
            },
          } as any
        }
      />,
    )
    expect(views().watch).toBeInTheDocument()
    expect(watched[0]).toMatchObject({ startFrame: 1000, endFrame: 1200 })
  })

  it('shows a whole game as a game', () => {
    render(
      <FullCard
        data={
          {
            path: '/r/game.slp',
            stage: 8,
            startFrame: -123,
            endFrame: 9000,
            lastFrame: 9000,
            players: [player(0, 1), player(1, 2)],
          } as any
        }
      />,
    )
    expect(views().watch).toBeNull()
    expect(views().flow).toBeInTheDocument()
  })
})
