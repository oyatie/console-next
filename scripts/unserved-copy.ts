// SPDX-License-Identifier: LicenseRef-Proprietary
// Shared by catalog and browser regressions.
export const roadmap = /아직 (?:열지 않았|서버|적는 칸|확인 기록)|파일럿 이후|연동 예정|화면이 열리면|not (?:yet (?:available|served|supported)|available yet|served yet)|after the pilot|comes after the pilot|coming later|once .*screen (?:opens|exists)|once their screens exist|not on the server|no server|not implemented/i;

/** Browser walks retain only the exact live strings assigned to another lane. */
export const withoutExceptions = (text: string, exceptions: readonly string[]) => exceptions.reduce((remaining, copy) => remaining.replaceAll(copy, ""), text);
