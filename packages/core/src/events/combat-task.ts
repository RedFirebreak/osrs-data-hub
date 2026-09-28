import { notImplemented } from '../todo';

/**
 * combatTask.taskName arrives untrimmed with a points suffix: " No Pressure (6 points)." →
 * { name: "No Pressure", points: 6 }. "(1 point)" is singular. Without a recognizable suffix the
 * trimmed text is returned with points null (a trailing "." is removed).
 */
export function parseCombatTaskName(taskName: unknown): { name: string; points: number | null } {
  return notImplemented('parseCombatTaskName');
}
