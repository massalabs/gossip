import { useTranslation } from 'react-i18next';

/** Shown instead of the app when another tab already runs it (web). */
export default function OpenElsewhere() {
  const { t } = useTranslation('common');
  return (
    <main className="flex min-h-dvh items-center justify-center bg-white px-6 text-neutral-900 dark:bg-neutral-950 dark:text-white">
      <section className="w-full max-w-md space-y-2 rounded-3xl border border-neutral-200 bg-white p-6 shadow-sm dark:border-neutral-800 dark:bg-neutral-900">
        <h1 className="text-2xl font-semibold">
          {t('instance.open_elsewhere')}
        </h1>
        <p className="text-sm text-neutral-600 dark:text-neutral-300">
          {t('instance.open_elsewhere_hint')}
        </p>
      </section>
    </main>
  );
}
