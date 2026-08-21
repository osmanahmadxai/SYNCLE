'use client';

import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

export function NumField({
  label,
  value,
  min,
  onChange,
}: {
  label: string;
  value: number;
  min?: number;
  onChange: (v: number) => void;
}) {
  return (
    <div className="grid gap-1.5">
      <Label className="text-xs">{label}</Label>
      <Input
        type="number"
        min={min}
        className="h-8"
        value={value}
        onChange={(e) => {
          // a cleared input coerces to 0 — clamp so e.g. batchSize can't be 0
          const n = Number(e.target.value);
          const floor = min ?? 0;
          onChange(Number.isFinite(n) ? Math.max(floor, n) : floor);
        }}
      />
    </div>
  );
}
