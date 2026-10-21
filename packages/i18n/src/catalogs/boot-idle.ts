// The idle sign-out warning and the re-auth dialog: shell copy, drawn beside the router before any screen
// catalog, so it ships in the entry with boot.ts (which spreads it). Same rules as boot.ts.
export const bootIdleKo = {
  "idle.reauth.title": "다시 로그인",
  "idle.reauth.idle": "일정 시간 사용하지 않아 보안을 위해 로그아웃되었습니다. 작성 중인 내용은 이 화면에 그대로 있으니, 같은 계정으로 다시 로그인하면 이어서 작업할 수 있습니다.",
  "idle.reauth.body": "보안을 위해 로그인이 끝났습니다. 다른 곳에서 로그아웃했거나 로그인이 종료된 경우입니다. 작성 중인 내용은 이 화면에 그대로 있으니, 같은 계정으로 다시 로그인하면 이어서 작업할 수 있습니다.",
  "idle.reauth.other": "다른 계정으로 로그인하면 작성 중인 내용은 남지 않습니다.",
  "idle.reauth.signIn": "패스키로 다시 로그인",
  "idle.reauth.signOut": "저장하지 않고 로그아웃",
  "idle.warn.body": "사용하지 않으면 {time}에 자동으로 로그아웃됩니다. 계속하려면 화면을 누르거나 “로그인 유지”를 누르십시오.",
  "idle.warn.stay": "로그인 유지",
  "auth.login.idle": "일정 시간 사용하지 않아 보안을 위해 로그아웃되었습니다. 다시 로그인하십시오.",
} as const;

export const bootIdleEn: Record<keyof typeof bootIdleKo, string> = {
  "idle.reauth.title": "Sign in again",
  "idle.reauth.idle": "For security, you were signed out after a period of inactivity. Your unsaved work is still on this screen; sign in again with the same account to continue.",
  "idle.reauth.body": "For security, your session ended: you signed out elsewhere, or the session was ended. Your unsaved work is still on this screen; sign in again with the same account to continue.",
  "idle.reauth.other": "If a different account signs in, unsaved work is not kept.",
  "idle.reauth.signIn": "Sign in again with a passkey",
  "idle.reauth.signOut": "Sign out without saving",
  "idle.warn.body": "If idle, you will be signed out automatically at {time}. To stay, click anywhere or choose “Stay signed in”.",
  "idle.warn.stay": "Stay signed in",
  "auth.login.idle": "For security, you were signed out after a period of inactivity. Sign in again.",
};
