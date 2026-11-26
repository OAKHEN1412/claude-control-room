// Shared profile avatar: a colored circle with the profile letter. Every account view uses this one.
import type { AccountInfo } from '../../../shared/accounts';
import { avatarColor, avatarInk } from '../accountDialogLogic';
import { displayLetter } from '../accountsView';
import './accountDialog.css';

export function AccountAvatar(
  props: { account: Pick<AccountInfo, 'color' | 'letter' | 'name'> & Partial<Pick<AccountInfo, 'builtin' | 'main'>>; size?: number },
) {
  const size = props.size ?? 32;
  const bg = avatarColor(props.account.color);
  return (
    <span
      className="acct-avatar"
      role="img"
      aria-label={props.account.name}
      style={{ width: size, height: size, background: bg, color: avatarInk(bg), fontSize: Math.round(size * 0.42) }}
    >
      {displayLetter(props.account)}
    </span>
  );
}
