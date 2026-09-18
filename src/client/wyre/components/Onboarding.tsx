import { type FormEvent, useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { AlertCircle, ArrowLeft, Loader2, Send } from "lucide-react";
import { startAuthentication } from "@simplewebauthn/browser";
import { callMethod, loginWithAccountPassword, loginWithOneTimeCode, logout, sendMagicLink } from "../../lib/api";
import { Brand } from "./Brand";
import { Field, PrimaryButton } from "./Glass";
import { slideVariants } from "../utils/motion";
import { getWyreNative, nativeBiometricAuthenticate } from "../utils/native";

type Step = "welcome" | "register" | "code" | "phone" | "login";

function errorText(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  if (/code/i.test(message) && /invalid|expired|incorrect/i.test(message)) {
    return "Неверный или просроченный код. Запросите новый.";
  }
  if (/disposable|temporary/i.test(message)) {
    return "Регистрация с временной почты запрещена.";
  }
  if (/rate limit|too many/i.test(message)) {
    return "Слишком много попыток. Повторите позже.";
  }
  return message || "Что-то пошло не так. Попробуйте ещё раз.";
}

function QrLogin() {
  const pattern = useMemo(
    () =>
      Array.from(
        { length: 121 },
        (_, index) =>
          [0, 1, 2, 11, 12, 21, 22, 98, 99, 108, 109, 110].includes(index) || (index * 7 + (index % 5)) % 9 < 4,
      ),
    [],
  );
  return (
    <div className="auth-qr">
      <div className="relative mx-auto h-36 w-36 rounded-[28px] bg-white p-3 shadow-2xl shadow-violet-950/20">
        <div className="grid h-full w-full grid-cols-11 gap-[2px]">
          {pattern.map((filled, index) => (
            <span key={index} className={filled ? "rounded-[1px] bg-slate-950" : "rounded-[1px] bg-transparent"} />
          ))}
        </div>
        <div className="qr-logo-safe">
          <div className="brand-mark qr-logo-mark">W</div>
        </div>
      </div>
      <div className="mt-6 max-w-[270px]">
        <h3 className="font-semibold">Быстрый вход</h3>
        <p className="mt-2 text-sm leading-6 text-[var(--muted)]">
          Уже есть аккаунт на другом устройстве? Отсканируйте QR-код в Настройках для быстрого входа
        </p>
      </div>
    </div>
  );
}

function AuthDivider() {
  return (
    <div className="auth-divider">
      <span />
      <em>или</em>
      <span />
    </div>
  );
}

function YandexButton({ children, onClick }: { children: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="yandex-auth-button">
      <span className="yandex-auth-icon">Я</span>
      <span>{children}</span>
    </button>
  );
}

function FormError({ message }: { message: string | null }) {
  return (
    <AnimatePresence>
      {message && (
        <motion.p
          initial={{ opacity: 0, y: -4 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0 }}
          className="mt-4 flex items-start gap-2 rounded-xl border border-red-500/25 bg-red-500/10 px-3 py-2.5 text-[13px] leading-5 text-red-300"
        >
          <AlertCircle size={15} className="mt-[1px] shrink-0" />
          <span>{message}</span>
        </motion.p>
      )}
    </AnimatePresence>
  );
}

/**
 * Real authentication.
 *
 * Registration: name + username + email -> Wyre's own 6-digit OTP -> profile
 * creation -> optional phone binding.
 * Login: email -> OTP -> username confirmation -> phone confirmation when the
 * account has one bound. Both secondary checks are enforced server-side.
 */
export function Onboarding({
  onComplete,
  needsProfile,
  needsPhoneSetup,
  needsChallenge,
  needsTotp,
  needsPin,
  needsAdditionalPassword,
  needsWebAuthn,
  needsDeviceApproval,
  requiresPhone,
  pendingEmail,
}: {
  onComplete: () => void;
  /** Session exists but the Wyre profile was never created (interrupted signup). */
  needsProfile?: boolean;
  /** A new profile exists but the optional phone decision is not finished. */
  needsPhoneSetup?: boolean;
  /** Session exists but the secondary login check is still due. */
  needsChallenge?: boolean;
  needsTotp?: boolean;
  needsPin?: boolean;
  needsAdditionalPassword?: boolean;
  needsWebAuthn?: boolean;
  needsDeviceApproval?: boolean;
  requiresPhone?: boolean;
  pendingEmail?: string | null;
}) {
  const resumeStep: Step = needsProfile ? "register" : (needsChallenge || needsTotp || needsPin || needsAdditionalPassword || needsWebAuthn || needsDeviceApproval) ? "login" : needsPhoneSetup ? "phone" : "welcome";
  const [step, setStep] = useState<Step>(resumeStep);
  const [name, setName] = useState("");
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState(pendingEmail ?? "");
  const [code, setCode] = useState("");
  const [phone, setPhone] = useState("");
  // 0 email, 1 code, 2 username, 3 phone, 4 TOTP, 5 PIN, 6 WebAuthn, 7 device approval, 8 additional password
  const [loginStage, setLoginStage] = useState(needsChallenge ? 2 : needsTotp ? 4 : needsPin ? 5 : needsAdditionalPassword ? 8 : needsWebAuthn ? 6 : needsDeviceApproval ? 7 : 0);
  const [passwordMode, setPasswordMode] = useState(false);
  const [loginPassword, setLoginPassword] = useState("");
  const [loginValue, setLoginValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Surface Yandex ID OAuth failures redirected back with `?authError=...`.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const authError = params.get("authError");
    if (authError) {
      setError(authError);
      params.delete("authError");
      const rest = params.toString();
      window.history.replaceState(null, "", rest ? `${window.location.pathname}?${rest}` : window.location.pathname);
    }
  }, []);

  const title =
    step === "register"
      ? needsProfile
        ? "Завершите профиль"
        : "Создайте аккаунт"
      : step === "code"
        ? "Проверьте почту"
        : step === "phone"
          ? "Оставайтесь на связи"
          : "С возвращением";

  function reset(next: Step) {
    setError(null);
    setNotice(null);
    setCode("");
    setLoginValue("");
    setStep(next);
  }

  async function submitRegister(event: FormEvent) {
    event.preventDefault();
    setError(null);

    // Session already authenticated (resumed profile step) — just create it.
    if (needsProfile) {
      setBusy(true);
      try {
        await callMethod("wyre.completeSignup", { name, username });
        setStep("phone");
      } catch (caught) {
        setError(errorText(caught));
      } finally {
        setBusy(false);
      }
      return;
    }

    setBusy(true);
    try {
      const check = (await callMethod("wyre.checkSignup", { email, username })) as {
        emailRegistered: boolean;
        usernameTaken: boolean;
      };
      if (check.usernameTaken) {
        setError("Этот username уже занят — выберите другой.");
        return;
      }
      await sendMagicLink({ email });
      setNotice(check.emailRegistered ? "На этот email уже есть аккаунт — код выполнит вход в него." : null);
      setStep("code");
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setBusy(false);
    }
  }

  async function submitCode(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await loginWithOneTimeCode({ email, code });
      const result = (await callMethod("wyre.completeSignup", { name, username })) as {
        existingAccount: boolean;
      };
      if (result.existingAccount) {
        onComplete();
        return;
      }
      setStep("phone");
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setBusy(false);
    }
  }

  async function savePhone(value: string | null) {
    setError(null);
    setBusy(true);
    try {
      await callMethod("wyre.setPhone", { phone: value });
      onComplete();
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setBusy(false);
    }
  }

  async function submitLogin(event: FormEvent) {
    event.preventDefault();
    if (loginStage < 6 && loginStage !== 8 && !loginValue.trim()) return;
    if (loginStage === 8 && !loginValue.trim()) return;
    setError(null);
    setBusy(true);
    try {
      if (loginStage === 0) {
        if (passwordMode) {
          await loginWithAccountPassword({ email: loginValue.trim(), password: loginPassword });
          setEmail(loginValue.trim());
          setLoginPassword("");
          const state = (await callMethod("wyre.session", {})) as { needsProfile: boolean };
          if (state.needsProfile) {
            setLoginValue("");
            onComplete();
            return;
          }
          setLoginStage(2);
          setLoginValue("");
          return;
        }
        await sendMagicLink({ email: loginValue.trim() });
        setEmail(loginValue.trim());
        setLoginStage(1);
        setLoginValue("");
      } else if (loginStage === 1) {
        await loginWithOneTimeCode({ email, code: loginValue.trim() });
        // The code also creates the account when the email was unknown — in that
        // case there is no Wyre profile yet, so finish registration instead.
        const state = (await callMethod("wyre.session", {})) as { needsProfile: boolean };
        if (state.needsProfile) {
          setLoginValue("");
          onComplete();
          return;
        }
        setLoginStage(2);
        setLoginValue("");
      } else if (loginStage === 2) {
        const result = (await callMethod("wyre.verifyUsername", { username: loginValue.trim() })) as {
          done: boolean;
          requiresPhone: boolean;
        };
        if (result.done) {
          await advanceLogin();
          return;
        }
        setLoginStage(3);
        setLoginValue("");
      } else if (loginStage === 3) {
        await callMethod("wyre.verifyPhone", { phone: loginValue.trim() });
        await advanceLogin();
        return;
      } else if (loginStage === 4) {
        await callMethod("wyre.verifyTotpLogin", { code: loginValue.trim() });
        await advanceLogin();
        return;
      } else if (loginStage === 5) {
        await callMethod("wyre.verifyPinLogin", { pin: loginValue.trim() });
        await advanceLogin();
        return;
      } else if (loginStage === 8) {
        await callMethod("wyre.verifyAdditionalPasswordLogin", { password: loginValue.trim() });
        await advanceLogin();
        return;
      } else if (loginStage === 6) {
        const native = getWyreNative();
        if (native && native.biometricAvailable()) {
          // Android WebView has no WebAuthn: the shell confirms with the
          // device lock (fingerprint / face / PIN) instead.
          const confirmed = await nativeBiometricAuthenticate("Подтвердите вход в Wyre");
          if (!confirmed) throw new Error("Биометрическое подтверждение отклонено");
          await callMethod("wyre.verifyNativeAppUnlock", {});
        } else {
          if (!window.PublicKeyCredential) throw new Error("Этот браузер не поддерживает биометрию WebAuthn");
          const options = await callMethod("wyre.beginWebAuthnAuthentication", {}) as Parameters<typeof startAuthentication>[0]["optionsJSON"];
          const response = await startAuthentication({ optionsJSON: options });
          await callMethod("wyre.finishWebAuthnAuthentication", { response });
        }
        await advanceLogin();
        return;
      } else {
        onComplete();
        return;
      }
    } catch (caught) {
      const message = errorText(caught);
      setError(message);
      if (/Начните вход заново/.test(message)) {
        await logout();
        setLoginStage(0);
        setLoginValue("");
      }
    } finally {
      setBusy(false);
    }
  }

  async function advanceLogin() {
    const state = (await callMethod("wyre.session", {})) as {
      needsTotp?: boolean;
      needsPin?: boolean;
      needsAdditionalPassword?: boolean;
      needsWebAuthn?: boolean;
      needsDeviceApproval?: boolean;
    };
    setLoginValue("");
    if (state.needsTotp) setLoginStage(4);
    else if (state.needsPin) setLoginStage(5);
    else if (state.needsAdditionalPassword) setLoginStage(8);
    else if (state.needsWebAuthn) setLoginStage(6);
    else if (state.needsDeviceApproval) setLoginStage(7);
    else onComplete();
  }

  async function abandonSession() {
    await logout();
    window.location.reload();
  }

  if (step === "welcome") {
    return (
      <main className="auth-page">
        <div className="auth-orb auth-orb-one" />
        <div className="auth-orb auth-orb-two" />
        <motion.div
          initial={{ opacity: 0, y: 28 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.7, ease: [0.16, 1, 0.3, 1] }}
          className="relative z-10 flex max-w-xl flex-col items-center px-5 text-center"
        >
          <Brand />
          <h1 className="mt-12 text-4xl font-semibold tracking-[-0.045em] sm:text-6xl">Добро пожаловать в Wyre</h1>
          <p className="mt-5 max-w-md text-base leading-7 text-[var(--muted)] sm:text-lg">
            Общение без лишнего шума. Быстрые чаты, звонки и всё важное рядом.
          </p>
          <PrimaryButton onClick={() => reset("register")} className="mt-10 min-w-48">
            Начать
          </PrimaryButton>
          <button
            onClick={() => {
              reset("login");
              setLoginStage(0);
            }}
            className="mt-5 text-sm text-[var(--muted)] transition hover:text-[var(--text)]"
          >
            У меня уже есть аккаунт
          </button>
        </motion.div>
      </main>
    );
  }

  return (
    <main className="auth-page p-5 sm:p-8">
      <div className="auth-orb auth-orb-one" />
      <motion.div initial={{ opacity: 0, scale: 0.98 }} animate={{ opacity: 1, scale: 1 }} className="auth-shell">
        <section className="auth-form-side">
          <button
            onClick={() => (needsProfile || needsPhoneSetup || needsChallenge ? abandonSession() : reset("welcome"))}
            className="mb-10 flex items-center gap-2 text-sm text-[var(--muted)] transition hover:text-[var(--text)]"
          >
            <ArrowLeft size={16} /> Назад
          </button>
          <Brand compact />
          <div className="mt-10 max-w-sm">
            <AnimatePresence mode="wait">
              <motion.div key={`${step}-${loginStage}`} {...slideVariants(1)}>
                <h1 className="text-3xl font-semibold tracking-[-0.04em]">{title}</h1>

                {step === "register" && (
                  <form className="mt-8 space-y-4" onSubmit={submitRegister}>
                    <Field label="Имя" value={name} onChange={setName} placeholder="Как к вам обращаться" autoFocus />
                    <Field label="Username" value={username} onChange={setUsername} placeholder="@username" />
                    {!needsProfile && (
                      <Field label="Email" value={email} onChange={setEmail} placeholder="you@example.com" type="email" />
                    )}
                    <PrimaryButton
                      type="submit"
                      disabled={!name || !username || (!needsProfile && !email) || busy}
                      className="mt-3 w-full"
                    >
                      {busy && <Loader2 size={17} className="animate-spin" />}
                      {needsProfile ? "Сохранить профиль" : "Отправить код"}
                      {!busy && !needsProfile && <Send size={17} />}
                    </PrimaryButton>
                    <FormError message={error} />
                    {!needsProfile && (
                      <>
                        <AuthDivider />
                        <YandexButton onClick={() => { window.location.href = "/auth/yandex"; }}>
                          Зарегистрироваться через Яндекс ID
                        </YandexButton>
                      </>
                    )}
                  </form>
                )}

                {step === "code" && (
                  <form className="mt-8" onSubmit={submitCode}>
                    <p className="mb-6 text-sm leading-6 text-[var(--muted)]">
                      Мы отправили 6-значный код на {email || "вашу почту"}. Если письма нет, проверьте папку «Спам».
                    </p>
                    {notice && <p className="mb-4 text-[13px] leading-5 text-[var(--accent1)]">{notice}</p>}
                    <Field
                      label="Код подтверждения"
                      value={code}
                      onChange={(value) => setCode(value.replace(/\D/g, ""))}
                      placeholder="000000"
                      maxLength={6}
                      autoFocus
                    />
                    <PrimaryButton type="submit" disabled={code.length !== 6 || busy} className="mt-6 w-full">
                      {busy && <Loader2 size={17} className="animate-spin" />}
                      Регистрация
                    </PrimaryButton>
                    <FormError message={error} />
                    <button
                      type="button"
                      disabled={busy}
                      onClick={async () => {
                        setError(null);
                        setBusy(true);
                        try {
                          await sendMagicLink({ email });
                          setNotice("Новый код отправлен.");
                        } catch (caught) {
                          setError(errorText(caught));
                        } finally {
                          setBusy(false);
                        }
                      }}
                      className="mt-5 w-full text-sm text-[var(--muted)] transition hover:text-[var(--text)]"
                    >
                      Отправить код ещё раз
                    </button>
                  </form>
                )}

                {step === "phone" && (
                  <div className="mt-7">
                    <p className="text-sm leading-6 text-[var(--muted)]">
                      Рекомендуем привязать номер, чтобы близкие могли найти вас автоматически.
                    </p>
                    <div className="mt-6 flex gap-2">
                      <span className="glass-select flex items-center gap-2">RU +7</span>
                      <input
                        className="glass-input min-w-0 flex-1"
                        value={phone}
                        onChange={(event) => setPhone(event.target.value.replace(/[^\d\s()-]/g, ""))}
                        placeholder="999 000-00-00"
                      />
                    </div>
                    <FormError message={error} />
                    <button
                      onClick={() => savePhone(null)}
                      disabled={busy}
                      className="mt-6 w-full text-sm text-[var(--muted)] transition hover:text-[var(--text)]"
                    >
                      Продолжить без номера
                    </button>
                    <PrimaryButton disabled={!phone.trim() || busy} onClick={() => savePhone(`7${phone}`)} className="mt-3 w-full">
                      {busy && <Loader2 size={17} className="animate-spin" />}
                      Продолжить
                    </PrimaryButton>
                  </div>
                )}

                {step === "login" && (
                  <form className="mt-8" onSubmit={submitLogin}>
                    <p className="mb-6 text-sm leading-6 text-[var(--muted)]">
                      {loginStage === 0 && (passwordMode ? "Введите email и пароль аккаунта." : "Введите email, привязанный к вашему аккаунту.")}
                      {loginStage === 1 && `Код отправлен на ${email}. Введите его, чтобы продолжить.`}
                      {loginStage === 2 && "Теперь укажите username аккаунта."}
                      {loginStage === 3 && "Для этого аккаунта включено дополнительное подтверждение."}
                      {loginStage === 4 && "Введите код из приложения-аутентификатора."}
                      {loginStage === 5 && "Введите 4-значный PIN-код аккаунта."}
                      {loginStage === 6 && "Подтвердите вход через системную биометрию устройства."}
                      {loginStage === 7 && "Вход ожидает подтверждения на одном из доверенных устройств."}
                      {loginStage === 8 && "Введите дополнительный пароль аккаунта."}
                    </p>
                    {loginStage !== 6 && loginStage !== 7 && <Field
                      label={
                        loginStage === 0
                          ? "Email"
                          : loginStage === 1
                            ? "Код"
                            : loginStage === 2
                              ? "Username"
                              : loginStage === 3
                                ? "Введите привязанный номер"
                                : loginStage === 4
                                  ? "Код двухфакторной аутентификации"
                                  : loginStage === 8
                                    ? "Дополнительный пароль"
                                    : "PIN-код"
                      }
                      value={loginValue}
                      onChange={setLoginValue}
                      type={loginStage === 8 ? "password" : undefined}
                      placeholder={
                        loginStage === 0
                          ? "you@example.com"
                          : loginStage === 1
                            ? "000000"
                            : loginStage === 2
                              ? "@username"
                              : loginStage === 3
                                ? "+7 999 000-00-00"
                                : loginStage === 4
                                  ? "000000"
                                  : loginStage === 8
                                    ? "Дополнительный пароль"
                                    : "0000"
                      }
                      autoFocus
                    />}
                    {loginStage === 0 && passwordMode && (
                      <div className="mt-4">
                        <Field label="Пароль" value={loginPassword} onChange={setLoginPassword} type="password" placeholder="Пароль аккаунта" />
                      </div>
                    )}
                    <PrimaryButton type="submit" disabled={(loginStage < 6 && !loginValue.trim()) || (loginStage === 8 && !loginValue.trim()) || (loginStage === 0 && passwordMode && !loginPassword) || busy} className="mt-6 w-full">
                      {busy && <Loader2 size={17} className="animate-spin" />}
                      {loginStage === 6 ? "Подтвердить биометрией" : loginStage === 7 ? "Проверить статус" : loginStage >= 3 || (loginStage === 2 && !requiresPhone) ? "Войти" : passwordMode ? "Войти" : "Продолжить"}
                    </PrimaryButton>
                    <FormError message={error} />
                    {loginStage === 0 && (
                      <>
                        <button
                          type="button"
                          onClick={() => { setPasswordMode((value) => !value); setLoginPassword(""); setError(null); }}
                          className="mt-4 w-full text-sm text-[var(--muted)] transition hover:text-[var(--text)]"
                        >
                          {passwordMode ? "Войти по коду из письма" : "Войти по паролю аккаунта"}
                        </button>
                        <AuthDivider />
                        <YandexButton onClick={() => { window.location.href = "/auth/yandex"; }}>
                          Войти через Яндекс ID
                        </YandexButton>
                        <button
                          type="button"
                          onClick={() => reset("register")}
                          className="mt-5 w-full text-sm text-[var(--muted)] transition hover:text-[var(--text)]"
                        >
                          Создать новый аккаунт
                        </button>
                      </>
                    )}
                  </form>
                )}
              </motion.div>
            </AnimatePresence>
          </div>
        </section>
        <QrLogin />
      </motion.div>
    </main>
  );
}
