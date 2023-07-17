import React from 'react';
import clsx from 'clsx';

interface IProps {
  placeholder?: string;
  error?: string;
  label?: string | React.ReactNode;
  className?: string;
  isInvalid?: boolean;
  type?: HTMLInputElement['type'];
  onChange?: (e: React.ChangeEvent<HTMLInputElement>) => void;
  name?: string;
  onBlur?: (e: React.FocusEvent<HTMLInputElement>) => void;
  disabled?: boolean;
  value?: string;
  readOnly?: boolean;
  min?: number;
  max?: number;
  size?: 'sm' | 'lg';
}

export const Input = React.forwardRef<HTMLInputElement, IProps>(
  ({ onChange, onBlur, name, label, placeholder, error, type = 'text', className, value, isInvalid, disabled, readOnly, min, max, size }, ref) => (
    <div className={clsx(className)}>
      {label && (
        <label htmlFor={name} className="form-label">
          {label}
        </label>
      )}
      {/* eslint-disable-next-line jsx-a11y/no-redundant-roles */}
      <input
        min={type === 'number' ? min : undefined}
        max={type === 'number' ? max : undefined}
        aria-label={name}
        role="textbox"
        disabled={disabled}
        name={name}
        id={name}
        onBlur={onBlur}
        onChange={onChange}
        value={value}
        type={type}
        ref={ref}
        className={clsx('form-control', { 'is-invalid is-invalid-lite': error || isInvalid, 'form-control-sm': size === 'sm' })}
        placeholder={placeholder}
        readOnly={readOnly}
      />
      {error && <div className="invalid-feedback">{error}</div>}
    </div>
  ),
);
