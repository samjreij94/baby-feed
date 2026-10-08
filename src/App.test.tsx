import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import App from './App';

describe('scaffold smoke', () => {
  it('renders the placeholder app', () => {
    render(<App />);
    expect(screen.getByRole('heading', { name: 'Baby Feed' })).toBeInTheDocument();
  });

  it('has fake IndexedDB in tests', () => {
    expect(typeof indexedDB.open).toBe('function');
  });
});
