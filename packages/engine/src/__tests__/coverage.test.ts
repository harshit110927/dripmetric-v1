import { describe, expect, it } from 'vitest';
import { CATALOG_EVENTS } from '@dripmetric/catalog';
import { coverage, METRIC_REQUIREMENTS, PAID_EVENT } from '../mapping/coverage.js';

/**
 * The coverage checklist (brief Appendix B).
 *
 * The thing worth testing is not the arithmetic, it is the promise: every number the
 * product can show is either on and explainable, or off with a plain sentence saying
 * which event would turn it on.
 */

const ALL_NAMES = new Set(
  CATALOG_EVENTS.filter((e) => e.priority !== undefined).map((e) => e.name),
);

describe('the coverage checklist', () => {
  it('scores nothing at zero and everything at 100', () => {
    expect(coverage({ arriving: new Set(), unmappedCount: 0 }).score).toBe(0);
    expect(coverage({ arriving: ALL_NAMES, unmappedCount: 0 }).score).toBe(100);
  });

  it('switches nothing off when every checklist event arrives', () => {
    const result = coverage({ arriving: ALL_NAMES, unmappedCount: 0 });
    expect(result.switchedOff).toEqual([]);
    expect(result.paidEventArriving).toBe(true);
  });

  it('weighs a missing "must" event more heavily than a missing "could"', () => {
    const withoutMust = new Set(ALL_NAMES);
    withoutMust.delete('Signed Up'); // must
    const withoutCould = new Set(ALL_NAMES);
    withoutCould.delete('Signed In'); // could

    expect(coverage({ arriving: withoutMust, unmappedCount: 0 }).score).toBeLessThan(
      coverage({ arriving: withoutCould, unmappedCount: 0 }).score,
    );
  });

  it('every checklist event appears in exactly one tier', () => {
    const result = coverage({ arriving: new Set(), unmappedCount: 0 });
    const counted = result.tiers.reduce((sum, tier) => sum + tier.total, 0);
    expect(counted).toBe(result.items.length);
    expect(result.items).toHaveLength(ALL_NAMES.size);
  });

  /*
   * Settled decision 9, stated as a test: "the dashboard works before it arrives;
   * 'intent but didn't pay' and potential revenue stay off, with a plain note."
   */
  it('turns revenue off, and only revenue, when the paid event is missing', () => {
    const arriving = new Set(ALL_NAMES);
    arriving.delete(PAID_EVENT);

    const result = coverage({ arriving, unmappedCount: 0 });

    expect(result.paidEventArriving).toBe(false);
    expect(result.switchedOff.map((s) => s.metric).sort()).toEqual([
      "Intent but didn't pay",
      'Potential revenue',
    ]);
    for (const off of result.switchedOff) {
      expect(off.because).toContain(`"${PAID_EVENT}"`);
      expect(off.because).toMatch(/so this is off\.$/);
    }
  });

  it('says "A or B" for a requirement either event satisfies', () => {
    const arriving = new Set(ALL_NAMES);
    arriving.delete('Onboarding Step Viewed');
    // The other half of the pair still arrives, so stalls stay on.
    expect(coverage({ arriving, unmappedCount: 0 }).switchedOff.map((s) => s.metric)).not.toContain(
      'Where people stall',
    );

    arriving.delete('Onboarding Step Completed');
    const stalls = coverage({ arriving, unmappedCount: 0 }).switchedOff.find(
      (s) => s.metric === 'Where people stall',
    );
    expect(stalls?.because).toContain(' or ');
  });

  it('says "A and B" when every named event is needed', () => {
    const arriving = new Set(ALL_NAMES);
    arriving.delete('Page Viewed');
    arriving.delete('Page Left');
    const timing = coverage({ arriving, unmappedCount: 0 }).switchedOff.find(
      (s) => s.metric === 'How long each step takes',
    );
    expect(timing?.because).toContain(' and ');
  });

  /*
   * Every required event must be ON the checklist, not merely in the catalog.
   *
   * This is the test that found a real bug: "Failed payments" required
   * `Payment Failed`, which carries no checklist priority because it happens after
   * a first payment. The metric could never have turned on, whatever the founder
   * sent, and the screen would have told them to send an event that would not have
   * helped. The requirement was wrong, not the catalog.
   */
  it('requires only events the checklist can actually ask for', () => {
    const catalogNames = new Set(CATALOG_EVENTS.map((e) => e.name));
    for (const requirement of METRIC_REQUIREMENTS) {
      for (const name of [...(requirement.all ?? []), ...(requirement.any ?? [])]) {
        expect(catalogNames, `${requirement.metric} needs "${name}"`).toContain(name);
        expect(ALL_NAMES, `${requirement.metric} needs "${name}" on the checklist`).toContain(name);
      }
    }
  });

  it('counts the Inbox, which counts toward nothing else', () => {
    const result = coverage({ arriving: ALL_NAMES, unmappedCount: 7 });
    expect(result.unmappedCount).toBe(7);
    // Unmapped names do not change coverage: they are not events we understand.
    expect(result.score).toBe(100);
  });
});
