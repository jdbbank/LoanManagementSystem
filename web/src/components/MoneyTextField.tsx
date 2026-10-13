import { useRef, type ChangeEvent } from 'react';
import TextField, { type TextFieldProps } from '@mui/material/TextField';

type MoneyTextFieldProps = Omit<TextFieldProps, 'inputRef' | 'onChange' | 'type' | 'value'> & {
  allowNegative?: boolean;
  minValue?: number;
  onChange: (value: string) => void;
  value: string | number;
};

function normalizeMoneyInput(value: string, allowNegative: boolean): string {
  const hasNegativeSign = allowNegative && value.trimStart().startsWith('-');
  const cleaned = value.replace(/,/g, '').replace(/[^\d.]/g, '');
  const [integerPart = '', ...fractionParts] = cleaned.split('.');
  const fractionPart = fractionParts.join('');
  const normalizedInteger = integerPart.replace(/^0+(?=\d)/, '');
  const normalized = fractionParts.length > 0
    ? `${normalizedInteger}.${fractionPart}`
    : normalizedInteger;

  return `${hasNegativeSign ? '-' : ''}${normalized}`;
}

function formatMoneyInput(value: string): string {
  const negative = value.startsWith('-');
  const unsigned = negative ? value.slice(1) : value;
  const [integerPart = '', fractionPart] = unsigned.split('.');
  const groupedInteger = integerPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const formatted = fractionPart === undefined ? groupedInteger : `${groupedInteger}.${fractionPart}`;

  return `${negative ? '-' : ''}${formatted}`;
}

function countNumericCharacters(value: string): number {
  return (value.match(/[\d.-]/g) ?? []).length;
}

export default function MoneyTextField({
  allowNegative = false,
  minValue,
  onChange,
  value,
  ...props
}: MoneyTextFieldProps) {
  const localInputRef = useRef<HTMLInputElement | null>(null);
  const displayedValue = formatMoneyInput(String(value));
  const validateMinimum = (input: HTMLInputElement | HTMLTextAreaElement, amount: string) => {
    const isBelowMinimum = amount !== '' && minValue !== undefined && Number(amount) < minValue;
    input.setCustomValidity(isBelowMinimum ? `Enter an amount of at least ${minValue}.` : '');
  };

  const handleChange = (event: ChangeEvent<HTMLInputElement>) => {
    const input = event.currentTarget;
    const cursorCharacterCount = countNumericCharacters(input.value.slice(0, input.selectionStart ?? input.value.length));
    const normalizedValue = normalizeMoneyInput(input.value, allowNegative);
    validateMinimum(input, normalizedValue);
    onChange(normalizedValue);

    requestAnimationFrame(() => {
      const formattedValue = formatMoneyInput(normalizedValue);
      let cursorPosition = 0;
      let countedCharacters = 0;
      while (cursorPosition < formattedValue.length && countedCharacters < cursorCharacterCount) {
        if (/[\d.-]/.test(formattedValue[cursorPosition])) countedCharacters += 1;
        cursorPosition += 1;
      }
      localInputRef.current?.setSelectionRange(cursorPosition, cursorPosition);
    });
  };

  return (
    <TextField
      {...props}
      type="text"
      value={displayedValue}
      onChange={handleChange}
      onBlur={(event) => validateMinimum(event.currentTarget, normalizeMoneyInput(event.currentTarget.value, allowNegative))}
      inputRef={(element: HTMLInputElement | null) => { localInputRef.current = element; }}
      slotProps={{
        ...props.slotProps,
        htmlInput: {
          inputMode: 'decimal',
          ...props.slotProps?.htmlInput,
        },
      }}
    />
  );
}
