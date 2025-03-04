import React, { FC, ReactElement } from 'react';
import { render, RenderOptions, renderHook } from '@testing-library/react';
import { Toaster } from 'react-hot-toast';
import { NextIntlProvider } from 'next-intl';
import ue from '@testing-library/user-event';
import messages from '../src/client/messages/en.json';

const userEvent = ue.setup();

const AllTheProviders: FC<{ children: React.ReactNode }> = ({ children }) => (
  <NextIntlProvider locale="en" messages={messages}>
    {children}
    <Toaster />
  </NextIntlProvider>
);

const customRender = (ui: ReactElement, options?: Omit<RenderOptions, 'wrapper'>) => render(ui, { wrapper: AllTheProviders, ...options });
const customRenderHook = <Props, Result>(callback: (props: Props) => Result, options?: Omit<RenderOptions, 'wrapper'>) => renderHook(callback, { wrapper: AllTheProviders, ...options });

export * from '@testing-library/react';
export { customRender as render };
export { customRenderHook as renderHook };
export { userEvent };
