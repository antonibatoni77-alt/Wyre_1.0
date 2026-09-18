/** Branded OTP email for the Wyre sign-in / sign-up flow. */
function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;',
  })[character] ?? character);
}

export function magicLinkEmail({
  email,
  code,
  magicLinkUrl,
}: {
  name: string;
  email: string;
  magicLinkUrl: string;
  code: string;
}) {
  const spaced = code.replace(/\s+/g, '');
  const safeEmail = escapeHtml(email);
  const safeMagicLink = escapeHtml(magicLinkUrl);
  return `<!doctype html>
<html lang="ru">
  <body style="margin:0;padding:32px 16px;background:#080a12;font-family:'Segoe UI',Helvetica,Arial,sans-serif;color:#f7f8fc;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:460px;margin:0 auto;background:#111525;border-radius:24px;border:1px solid rgba(255,255,255,.09);">
      <tr>
        <td style="padding:36px 32px;">
          <div style="display:inline-block;width:44px;height:44px;border-radius:14px;background:linear-gradient(140deg,#8b5cf6,#2563eb);text-align:center;line-height:44px;font-weight:700;font-size:20px;">W</div>
          <h1 style="margin:24px 0 8px;font-size:22px;font-weight:600;letter-spacing:-.02em;">Код входа в Wyre</h1>
          <p style="margin:0 0 24px;font-size:14px;line-height:22px;color:#8f96a8;">
            Введите этот код на экране подтверждения для <strong style="color:#f7f8fc;">${safeEmail}</strong>.
            Код действует ограниченное время и используется один раз.
          </p>
          <div style="padding:18px;border-radius:16px;background:rgba(139,92,246,.12);border:1px solid rgba(139,92,246,.35);text-align:center;font-size:32px;font-weight:700;letter-spacing:10px;">
            ${spaced}
          </div>
          <p style="margin:24px 0 0;font-size:13px;line-height:21px;color:#8f96a8;">
            Или откройте ссылку на этом устройстве:<br />
            <a href="${safeMagicLink}" style="color:#a78bfa;word-break:break-all;">${safeMagicLink}</a>
          </p>
          <p style="margin:24px 0 0;font-size:12px;line-height:19px;color:#5f6678;">
            Если вы не запрашивали вход в Wyre — просто проигнорируйте это письмо.
          </p>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}
