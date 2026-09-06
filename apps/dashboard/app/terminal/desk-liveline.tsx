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
}: DeskLivelineProps) {
  const motion = useMotionPrefs();
  const nowSecs = (motion.nowMs ?? Date.now()) / 1000;
  const overlay = series ?? [];
  const clocks = overlay.length ? overlay.flatMap((row) => row.data) : points;
  const span = seriesSpanSecs(clocks, nowSecs);
  const windows = useMemo(() => livelineWindows(clocks, nowSecs), [clocks, nowSecs]);
  const windowSecs = windows[windows.length - 1]?.secs ?? span;
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
  const data: LivelinePoint[] = solo ? solo.data : [...points];
  const latest = solo ? solo.value : (value ?? (data[data.length - 1]?.value ?? 0));
  const empty = !loading && data.length === 0 && multi.length === 0;
  const allowDegen = degen && livelineDegen(returnPct) && !motion.reduce && !motion.coarse;

  return (
    <div className={className ? `line-frame ${className}` : 'line-frame'}>
      <Liveline
        data={data}
        value={latest}
        series={multi.length > 1 ? multi : undefined}
        theme="dark"
        color={solo?.color ?? color}
        window={windowSecs}
        windows={windows}
        windowStyle="text"
        grid
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
        formatTime={(t) => formatLivelineTime(t, span)}
        padding={{ top: showValue ? 52 : 16, right: 16, bottom: 28, left: 12 }}
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
