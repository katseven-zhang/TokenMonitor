import type { Query } from './api';

const keys: (keyof Query)[] = ['start', 'end', 'agent', 'model', 'project', 'session', 'search', 'offsetMinutes'];
export function sameQuery(left: Query, right: Query): boolean {
  return keys.every(key => left[key] === right[key]);
}
