import '@testing-library/jest-dom';
import { render } from '@testing-library/react';
import App from '../renderer/App';
import { config as defaultConfig } from '../constants/defaults';

beforeAll(() => {
  (window as any).electron = {
    ipcRenderer: {
      sendMessage: jest.fn(),
      once: (_channel: string, callback: (...args: any[]) => void) => {
        if (_channel === 'config') callback(defaultConfig);
        if (_channel === 'archive') callback(null);
        callback();
      },
      on: (_channel: string, _callback: (...args: any[]) => void) => {
        return () => {};
      },
    },
  };
});

describe('App', () => {
  it('should render', () => {
    expect(render(<App />)).toBeTruthy();
  });
});
