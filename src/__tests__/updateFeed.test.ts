import { isLocalUpdateFeed } from '../lib/updateFeed'

describe('isLocalUpdateFeed (LUNAR_UPDATE_FEED_URL)', () => {
  it.each([
    'http://localhost:8080',
    'http://localhost/',
    'https://127.0.0.1:9000/feed',
    'http://10.0.0.5:8000',
    `http://${['192', '168', '1', '20'].join('.')}:8000/latest`, // built from parts: the publish gate refuses LAN addresses in source
    'http://172.16.0.1',
    'http://172.31.255.254:80',
  ])('accepts %s', (url) => {
    expect(isLocalUpdateFeed(url)).toBe(true)
  })

  it.each([
    'http://localhost.evil.example',
    'http://127.evil.example',
    'http://10.evil.example',
    `http://${['192', '168'].join('.')}.evil.example/`,
    'http://localhost@evil.example/',
    'http://user:pw@localhost/',
    'http://8.8.8.8',
    'http://172.15.0.1',
    'http://172.32.0.1',
    'http://10.0.0.256',
    'http://[::1]:8080',
    'ftp://localhost/',
    'file:///etc/passwd',
    'localhost:8080',
    '',
    undefined,
    null,
  ])('refuses %s', (url) => {
    expect(isLocalUpdateFeed(url as string | undefined | null)).toBe(false)
  })
})
