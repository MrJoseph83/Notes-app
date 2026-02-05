import React from 'react';
import { render, screen } from '@testing-library/react';
import Login from './Login';

test('renders Login and Send Magic Link button', () => {
  render(<Login />);
  const btn = screen.getByRole('button', { name: /send magic link/i });
  expect(btn).toBeInTheDocument();
});
