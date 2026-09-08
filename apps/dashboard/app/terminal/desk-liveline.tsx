'use client';

import { Liveline, type LivelinePoint, type LivelineSeries } from 'liveline';
import { useEffect, useMemo, useState } from 'react';

import {
  formatLivelineTime,
  formatLivelineValue,
  LIVELINE_EMPTY,
  livelineDegen,
  livelineWindows,
  seriesSpanSecs,
  type LivelineClock,
  type LivelineOverlay,
  type LivelineUnit,
} from '../../lib/desk-liveline';

export type LivelineReference = {
  value: number;
  label?: string;
};

export type DeskLivelineProps = {
  points?: readonly LivelineClock[];
  value?: number | null;
  series?: readonly LivelineOverlay[];
  unit: LivelineUnit;
  color?: string;
  loading?: boolean;
  emptyText?: string;
  returnPct?: number | null;
  showValue?: boolean;
  degen?: boolean;
  className?: string;
  /** Polymarket-style threshold. Book OPEN passes average cost. */
  referenceLine?: LivelineReference;
  /** Thin Book OPEN sparkline — no window chips, no degen, no clip box. */
  compact?: boolean;
};

export function DeskLiveline({
  points = [],
  value = null,
  series,
  unit,
  color = '#e8edf2',
  loading = false,
  emptyText = LIVELINE_EMPTY,
  returnPct = null,
  showValue = true,
  degen = false,
  className,
  referenceLine,
  compact = false,
}: DeskLivelineProps) {
  const motion = useMotionPrefs();
  const nowSecs = (motion.nowMs ?? Date.now()) / 1000;
  const overlay = series ?? [];
  const clocks = overlay.length
    ? [...points, ...overlay.flatMap((row) => row.data)]
    : points;
  const span = seriesSpanSecs(clocks, nowSecs);
  const windows = useMemo(() => livelineWindows(clocks, nowSecs), [clocks, nowSecs]);
  const windowSecs = compact ? span : (windows[windows.length - 1]?.secs ?? span);
  const multi: LivelineSeries[] = overlay
    .filter((row) => row.data.length > 0)
    .map((row) => ({
      id: row.id,
      label: row.label,
      color: row.color,
      data: [...row.data],
      value: row.value,
    }));
  const solo = multi.length === 1 ? multi[0] : null;
  const data: LivelinePoint[] = solo && points.length === 0 ? solo.data : [...points];
  const latest = solo && points.length === 0
    ? solo.value
    : (value ?? (data[data.length - 1]?.value ?? 0));
  const empty = !loading && data.length === 0 && multi.length === 0;
  const allowDegen = !compact && degen && livelineDegen(returnPct) && !motion.reduce && !motion.coarse;
  const extraOnPoints = points.length > 0 && multi.length > 0;
  const livelineSeries = extraOnPoints
    ? [
      {
        id: 'mark',
        label: 'mark',
        color,
        data: [...points],
        value: latest,
      },
      ...multi,
    ]
    : (multi.length > 1 ? multi : undefined);

  return (
    <div
      className={className ? `line-frame ${className}` : 'line-frame'}
      style={compact ? { height: 72 } : undefined}
    >
      <Liveline
        data={data}
        value={latest}
        series={livelineSeries}
        theme="dark"
        color={solo?.color ?? color}
        window={windowSecs}
        windows={compact ? undefined : windows}
        windowStyle="text"
        seriesToggleCompact={motion.coarse}
        grid={!compact}
        badge={false}
        momentum={!motion.reduce}
        fill
        pulse={!motion.reduce}
        scrub
        exaggerate
        showValue={showValue && multi.length < 2}
        valueMomentumColor
        degen={allowDegen ? { scale: 0.7, downMomentum: true } : false}
        loading={loading}
        paused={motion.reduce || motion.hidden}
        emptyText={empty ? emptyText : LIVELINE_EMPTY}
        formatValue={(v) => formatLivelineValue(v, unit)}
        formatTime={compact ? () => '' : (t) => formatLivelineTime(t, span)}
        referenceLine={referenceLine}
        padding={compact
          ? { top: 6, right: 36, bottom: 6, left: 4 }
          : {
            top: showValue ? 52 : 16,
            right: multi.length > 1 ? 88 : 16,
            bottom: 28,
            left: 12,
          }}
      />
    </div>
  );
}

type MotionPrefs = {
  reduce: boolean;
  coarse: boolean;
  hidden: boolean;
  nowMs: number | null;
};

function useMotionPrefs(): MotionPrefs {
  const [reduce, setReduce] = useState(false);
  const [coarse, setCoarse] = useState(false);
  const [hidden, setHidden] = useState(false);
  const [nowMs, setNowMs] = useState<number | null>(null);

  useEffect(() => {
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const pointer = window.matchMedia('(pointer: coarse)');
    const sync = () => {
      setReduce(motion.matches);
      setCoarse(pointer.matches);
      setHidden(document.visibilityState === 'hidden');
      setNowMs(Date.now());
    };
    sync();
    motion.addEventListener('change', sync);
    pointer.addEventListener('change', sync);
    document.addEventListener('visibilitychange', sync);
    return () => {
      motion.removeEventListener('change', sync);
      pointer.removeEventListener('change', sync);
      document.removeEventListener('visibilitychange', sync);
    };
  }, []);

  return { reduce, coarse, hidden, nowMs };
}
