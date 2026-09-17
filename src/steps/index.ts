import type { Step } from '../work/work-types.js';
import type { StepHandler } from './types.js';
import { actionHandler } from './action.js';
import { orchestratedHandler } from './orchestrated.js';

const registry: Record<Step['type'], StepHandler<Step>> = {
  'action':       actionHandler      as unknown as StepHandler<Step>,
  'orchestrated': orchestratedHandler as unknown as StepHandler<Step>,
};

export function handlerFor<S extends Step>(step: S): StepHandler<S> {
  return registry[step.type] as unknown as StepHandler<S>;
}

export function initialStateForType(type: Step['type']): Step['state'] {
  return registry[type].initialState;
}

// Is this step done, whatever the outcome — resolved, failed, cancelled, or (ActionStep only)
// declined, which is a user veto of its write draft rather than a breakage. Mirrored
// client-side by isTerminalStep in pwa/vm/work-predicates.js; the two must agree.
export function isTerminalStep(step: Step): boolean {
  return !!step.failure || !!step.cancelled || step.state === 'resolved'
    || step.state === 'failed'
    || (step.type === 'action' && step.state === 'declined');
}

export { actionHandler, orchestratedHandler };
