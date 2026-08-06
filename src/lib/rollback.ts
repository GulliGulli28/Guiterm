import type { FleetRun, RollbackPlan } from "./types";

/** Whether a past run can be undone, and what to say about it either way. */
export interface RollbackAvailability {
  enabled: boolean;
  /** Shown on hover in both cases. When it can't be undone this is the whole
   * point: "why is this greyed out" is a question worth answering where it is
   * asked, which is why the button is disabled rather than hidden. */
  reason: string;
}

/**
 * Can this run be undone?
 *
 * The answer hinges on one thing: whether the run was recorded with the DSL
 * program it came from. Without it nothing knows which *operations* took place
 * — `perHostCommands` holds rendered shell, and inferring operations back out
 * of `apt-get install -y nginx` would mean parsing every package manager,
 * which is the job the DSL exists to avoid.
 *
 * Two ways to have no program, and they are worth telling apart because the
 * remedy differs: a free-command run never had one and never will, whereas an
 * older run simply predates the feature and its successors will be undoable.
 */
export function rollbackAvailability(run: FleetRun): RollbackAvailability {
  if (run.programText) {
    return { enabled: true, reason: "Voir ce qu'une annulation ferait, avant de l'exécuter" };
  }
  return {
    enabled: false,
    reason:
      "Run non annulable : il n'a pas été enregistré avec ses opérations "
      + "(commande libre, ou run antérieur à cette fonctionnalité)",
  };
}

/**
 * Whether a reviewed rollback has anything at all to run.
 *
 * Separate from "is it undoable": a run can be undoable in principle and still
 * produce an empty plan — every operation irreversible, or none of them
 * applying to these hosts any more. Offering "Exécuter" there would do nothing
 * and look broken.
 */
export function hasSomethingToRun(plan: RollbackPlan): boolean {
  return plan.groups.some((group) => group.command != null);
}
