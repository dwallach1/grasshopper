'use client';

import { useEffect, useMemo } from 'react';
import {
  Alignment,
  Fit,
  Layout,
  useRive,
  type Rive,
} from '@rive-app/react-canvas';

export type DeskRiveProps = {
  src: string;
  stateMachine: string;
  /** Play the state machine. False keeps the last frame (phone-safe). */
  playing?: boolean;
  autoplay?: boolean;
  className?: string;
  /** Drive named number inputs (e.g. `Level` 0–100). */
  numberInputs?: Readonly<Record<string, number>>;
  'aria-label'?: string;
};

/**
 * Shared Rive host. Keep `useRive` + `RiveComponent` here so parent re-renders
 * do not remount the canvas. Canvas renderer (not WebGL2) — one small instance
 * on a phone desk; smaller package, no extra WebGL context.
 *
 * Add files under `public/rive/` and pass `/rive/<name>.riv`.
 */
export function DeskRive({
  src,
  stateMachine,
  playing = false,
  autoplay = false,
  className,
  numberInputs,
  'aria-label': ariaLabel,
}: DeskRiveProps) {
  const layout = useMemo(
    () => new Layout({ fit: Fit.Contain, alignment: Alignment.Center }),
    [],
  );
  const { rive, RiveComponent } = useRive(
    {
      src,
      stateMachine,
      autoplay,
      layout,
      shouldDisableRiveListeners: true,
    },
    { shouldUseIntersectionObserver: true },
  );

  useEffect(() => {
    if (!rive) return;
    if (playing) rive.play();
    else rive.pause();
  }, [playing, rive]);

  useEffect(() => {
    if (!rive || !numberInputs) return;
    applyNumberInputs(rive, stateMachine, numberInputs);
  }, [numberInputs, rive, stateMachine]);

  useEffect(() => {
    function onVis() {
      if (document.visibilityState === 'hidden') rive?.pause();
    }
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, [rive]);

  return (
    <RiveComponent
      className={className}
      role="img"
      aria-label={ariaLabel ?? 'Desk motion chrome'}
    />
  );
}

function applyNumberInputs(
  rive: Rive,
  preferred: string,
  values: Readonly<Record<string, number>>,
): void {
  const machine = rive.stateMachineNames.includes(preferred)
    ? preferred
    : rive.stateMachineNames[0];
  if (!machine) return;
  const inputs = rive.stateMachineInputs(machine) ?? [];
  for (const [name, value] of Object.entries(values)) {
    const input = inputs.find((row) => row.name === name);
    if (input) input.value = value;
  }
}
