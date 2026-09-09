'use client';

import { stewardSpecies, type StewardBotKind } from '../../lib/desk-avatar';
import { STEWARD_EXPRESSIONS } from '../../lib/steward-motion';
import { StewardAvatar } from './steward-avatar';
import styles from './steward-expression-sheet.module.css';

const FACES: Array<{ slug: StewardBotKind; name: string }> = [
  { slug: 'quantanamo', name: 'QUANTANAMO' },
  { slug: 'oddsborne', name: 'ODDSBORNE' },
  { slug: 'bandit', name: 'BANDIT' },
];

export function StewardExpressionSheet() {
  return (
    <main className={styles.sheet} data-sheet="steward-expressions">
      <h1>Steward expression family</h1>
      <p>
        One soft circle, two cream eyes. QUANTANAMO / ODDSBORNE / BANDIT differ by fill and eye gap.
        Same morph engine as Team foil cards and Board icons.
      </p>
      <ol className={styles.tree} aria-label="StewardAvatar morph params">
        <li>StewardAvatar — slug, size, mood, alive, thinking, attending</li>
        <li>stewardDeskFaces — Board %, pulse, watching, open ticket</li>
        <li>stewardMotion — blink, glance, listen, think, surprise, caution, speak, pulse</li>
        <li>composeStewardPose — one disk + two pills</li>
        <li>paintStewardIcon — canvas 2d, eyes clipped to the disk</li>
      </ol>
      {FACES.map((face) => (
        <section key={face.slug} className={styles.row} data-steward={face.slug}>
          <header>
            <b>{face.name}</b>
            <i>{stewardSpecies(face.slug).fill}</i>
          </header>
          <ul>
            {STEWARD_EXPRESSIONS.map((expression) => (
              <li key={expression}>
                <StewardAvatar
                  slug={face.slug}
                  name={face.name}
                  size="board"
                  preview={expression}
                />
                <span>{expression}</span>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </main>
  );
}
