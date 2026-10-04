// Centralized room authorization. Browser-supplied role/from fields are never trusted.
export function roleForProfile(profile) {
  if (profile?.role === 'teacher') return 'guide';
  if (profile?.role === 'learner') return 'student';
  return null;
}

export function canAccessRoom(ctx, room) {
  if (!ctx?.user?.id || !room) return false;
  if (ctx.profile?.role === 'teacher') return room.teacherId === ctx.user.id;
  if (ctx.profile?.role === 'learner') return room.joinedLearners?.has(ctx.user.id) || false;
  return false;
}

const TEACHER_ACTIONS = new Set([
  'activity', 'change', 'frame', 'redact', 'speaking', 'question-mode', 'share-state',
  'offrecord', 'debrief', 'confirm', 'export',
]);
const LEARNER_ACTIONS = new Set(['activity', 'practice', 'practice-attempt']);
const SHARED_ACTIONS = new Set(['chat', 'language', 'curriculum']);

export function canPerformRoomAction(ctx, room, action) {
  if (!canAccessRoom(ctx, room)) return false;
  if (SHARED_ACTIONS.has(action)) return true;
  if (ctx.profile.role === 'teacher') return TEACHER_ACTIONS.has(action);
  if (ctx.profile.role === 'learner') return LEARNER_ACTIONS.has(action);
  return false;
}
