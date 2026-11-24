import {
  AlertCircle,
  BookOpen,
  CheckCircle2,
  Compass,
  Globe2,
  Loader2,
  RefreshCw,
  Save,
  ShieldCheck,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { useAuth } from '@/features/auth/authContext';
import {
  buildRawStudentProfilePayload,
  estimateFormCompletion,
  loadStudentProfileWithAuth,
  toStudentProfileFormState,
  updateStudentProfileWithAuth,
  validateStudentProfileForm,
  type QualificationFormState,
  type StudentProfileFormState,
} from '@/features/student/studentProfileClient';
import { isApiClientError } from '@/lib/apiClient';
import {
  FUNDING_NEEDS,
  GRADING_SCALE_NUMERIC_MAX,
  IELTS_SCORE_STATUSES,
  TARGET_STUDY_LEVELS,
  type FundingNeed,
  type GradingScaleCode,
  type IeltsScoreStatus,
  type StudentProfileResponse,
  type TargetStudyLevel,
} from '@shared/schemas/studentProfile.schema';

const STUDY_LEVEL_LABELS: Record<TargetStudyLevel, string> = {
  foundation: 'Foundation / Pathway',
  undergraduate: 'Undergraduate (Bachelor’s)',
  postgraduate_taught: 'Postgraduate Taught (Master’s)',
  postgraduate_research: 'Postgraduate Research (PhD / MPhil)',
  diploma: 'Diploma / Certificate',
};

const FUNDING_NEED_LABELS: Record<FundingNeed, string> = {
  self_funded: 'Self-funded / Family-sponsored',
  partial_scholarship_needed: 'Partial scholarship needed',
  full_scholarship_required: 'Full scholarship required',
  unknown: 'Still exploring options',
};

const IELTS_STATUS_LABELS: Record<IeltsScoreStatus, string> = {
  reported: 'Score received (reported)',
  planned: 'Planned (test scheduled or upcoming)',
  taken_pending_result: 'Exam taken (awaiting result)',
  not_tested: 'Not taken yet',
  waived: 'Waived / Exempt (e.g., MOI)',
  not_applicable: 'Not applicable',
  unknown: 'Unsure / Undecided',
};

const DESTINATION_PRESETS = [
  { code: 'GB', label: 'United Kingdom (GB)' },
  { code: 'US', label: 'United States (US)' },
  { code: 'CA', label: 'Canada (CA)' },
  { code: 'AU', label: 'Australia (AU)' },
  { code: 'DE', label: 'Germany (DE)' },
  { code: 'MY', label: 'Malaysia (MY)' },
  { code: 'SG', label: 'Singapore (SG)' },
  { code: 'JP', label: 'Japan (JP)' },
] as const;

const CURRENCY_OPTIONS = ['USD', 'GBP', 'EUR', 'CAD', 'AUD', 'BDT', 'INR'] as const;

function parseTargetCountryCodes(raw: string): string[] {
  return raw
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
}

interface QualificationSectionCardProps {
  idPrefix: 'ssc' | 'hsc';
  title: string;
  subtitle: string;
  value: QualificationFormState;
  gradingScales: StudentProfileResponse['gradingScales'];
  disabled: boolean;
  onChange: (next: QualificationFormState) => void;
}

function QualificationSectionCard({
  idPrefix,
  title,
  subtitle,
  value,
  gradingScales,
  disabled,
  onChange,
}: QualificationSectionCardProps) {
  const locked = disabled || value.isVerified;

  const handleScaleChange = (nextScale: GradingScaleCode) => {
    const defaultMax = GRADING_SCALE_NUMERIC_MAX[nextScale];
    onChange({
      ...value,
      gradingScaleCode: nextScale,
      maxScoreValue: defaultMax !== null ? String(defaultMax) : '',
    });
  };

  return (
    <div className="rounded-md border border-slate-200 bg-slate-50/60 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-semibold text-slate-900">{title}</h3>
            {value.enabled ? (
              <span
                className={`rounded border px-2 py-0.5 font-mono text-[11px] font-medium ${
                  value.isVerified
                    ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
                    : 'border-slate-200 bg-white text-slate-700'
                }`}
              >
                {value.isVerified ? 'Verified' : 'Self-reported'}
              </span>
            ) : null}
          </div>
          <p className="mt-0.5 text-xs text-slate-600">{subtitle}</p>
        </div>

        <label className="inline-flex cursor-pointer items-center gap-2 text-xs font-medium text-slate-800">
          <input
            type="checkbox"
            checked={value.enabled}
            disabled={locked}
            onChange={(e) => onChange({ ...value, enabled: e.target.checked })}
            className="h-4 w-4 rounded border-slate-300 text-blue-700 focus:ring-blue-600"
          />
          <span>Include {idPrefix.toUpperCase()} record</span>
        </label>
      </div>

      {value.enabled ? (
        <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <div className="sm:col-span-2">
            <label
              htmlFor={`${idPrefix}-board`}
              className="block text-xs font-medium text-slate-700"
            >
              Education Board / Institution <span className="text-red-600">*</span>
            </label>
            <input
              id={`${idPrefix}-board`}
              type="text"
              maxLength={200}
              disabled={locked}
              value={value.boardOrInstitution}
              onChange={(e) =>
                onChange({ ...value, boardOrInstitution: e.target.value })
              }
              placeholder={
                idPrefix === 'ssc'
                  ? 'e.g. Dhaka Board / CBSE'
                  : 'e.g. Notre Dame College / ISC'
              }
              className="mt-1 block w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-950 placeholder:text-slate-400 focus:border-blue-600 focus:outline-none disabled:bg-slate-100"
            />
          </div>

          <div>
            <label
              htmlFor={`${idPrefix}-country`}
              className="block text-xs font-medium text-slate-700"
            >
              Country (ISO-2) <span className="text-red-600">*</span>
            </label>
            <input
              id={`${idPrefix}-country`}
              type="text"
              maxLength={2}
              disabled={locked}
              value={value.countryCode}
              onChange={(e) =>
                onChange({ ...value, countryCode: e.target.value.toUpperCase() })
              }
              placeholder="BD or IN"
              className="mt-1 block w-full rounded-md border border-slate-300 bg-white px-3 py-2 font-mono text-sm uppercase text-slate-950 placeholder:text-slate-400 focus:border-blue-600 focus:outline-none disabled:bg-slate-100"
            />
          </div>

          <div>
            <label
              htmlFor={`${idPrefix}-stream`}
              className="block text-xs font-medium text-slate-700"
            >
              Group / Stream
            </label>
            <input
              id={`${idPrefix}-stream`}
              type="text"
              maxLength={160}
              disabled={locked}
              value={value.fieldOfStudy}
              onChange={(e) => onChange({ ...value, fieldOfStudy: e.target.value })}
              placeholder="e.g. Science, Commerce, Arts"
              className="mt-1 block w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-950 placeholder:text-slate-400 focus:border-blue-600 focus:outline-none disabled:bg-slate-100"
            />
          </div>

          <div>
            <label
              htmlFor={`${idPrefix}-scale`}
              className="block text-xs font-medium text-slate-700"
            >
              Grading Scale <span className="text-red-600">*</span>
            </label>
            <select
              id={`${idPrefix}-scale`}
              disabled={locked}
              value={value.gradingScaleCode}
              onChange={(e) => handleScaleChange(e.target.value as GradingScaleCode)}
              className="mt-1 block w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-950 focus:border-blue-600 focus:outline-none disabled:bg-slate-100"
            >
              {gradingScales.map((scale) => (
                <option key={scale.code} value={scale.code}>
                  {scale.name}
                </option>
              ))}
            </select>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div>
              <label
                htmlFor={`${idPrefix}-score`}
                className="block text-xs font-medium text-slate-700"
              >
                GPA / Score
              </label>
              <input
                id={`${idPrefix}-score`}
                type="number"
                step="0.01"
                min="0"
                disabled={locked}
                value={value.scoreValue}
                onChange={(e) => onChange({ ...value, scoreValue: e.target.value })}
                placeholder="e.g. 5.00"
                className="mt-1 block w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-950 placeholder:text-slate-400 focus:border-blue-600 focus:outline-none disabled:bg-slate-100"
              />
            </div>

            <div>
              <label
                htmlFor={`${idPrefix}-max-score`}
                className="block text-xs font-medium text-slate-700"
              >
                Scale Max
              </label>
              <input
                id={`${idPrefix}-max-score`}
                type="number"
                step="0.01"
                min="0.01"
                disabled={locked}
                value={value.maxScoreValue}
                onChange={(e) => onChange({ ...value, maxScoreValue: e.target.value })}
                placeholder="e.g. 5"
                className="mt-1 block w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-950 placeholder:text-slate-400 focus:border-blue-600 focus:outline-none disabled:bg-slate-100"
              />
            </div>
          </div>

          <div>
            <label
              htmlFor={`${idPrefix}-year`}
              className="block text-xs font-medium text-slate-700"
            >
              Completion Year
            </label>
            <input
              id={`${idPrefix}-year`}
              type="number"
              min="1950"
              max="2050"
              disabled={locked}
              value={value.completionYear}
              onChange={(e) => onChange({ ...value, completionYear: e.target.value })}
              placeholder="e.g. 2024"
              className="mt-1 block w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-950 placeholder:text-slate-400 focus:border-blue-600 focus:outline-none disabled:bg-slate-100"
            />
          </div>

          <div className="flex items-end pb-2">
            <label className="inline-flex cursor-pointer items-center gap-2 text-xs font-medium text-slate-800">
              <input
                type="checkbox"
                checked={value.isCompleted}
                disabled={locked}
                onChange={(e) => onChange({ ...value, isCompleted: e.target.checked })}
                className="h-4 w-4 rounded border-slate-300 text-blue-700 focus:ring-blue-600"
              />
              <span>Exam completed</span>
            </label>
          </div>
        </div>
      ) : (
        <p className="mt-2 text-xs text-slate-500">
          Optional: enable when you are ready to save your {idPrefix.toUpperCase()} board details and GPA.
        </p>
      )}
    </div>
  );
}

export function StudentProfilePanel() {
  const { getAccessToken } = useAuth();

  const [savedProfile, setSavedProfile] = useState<StudentProfileResponse | null>(null);
  const [formState, setFormState] = useState<StudentProfileFormState | null>(null);
  const [savedSnapshotJson, setSavedSnapshotJson] = useState<string>('');
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [isSaving, setIsSaving] = useState<boolean>(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [validationErrors, setValidationErrors] = useState<string[]>([]);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveSuccessNotice, setSaveSuccessNotice] = useState<string | null>(null);

  const applyLoadFailure = useCallback((err: unknown) => {
    if (isApiClientError(err)) {
      const reqSuffix = err.requestId ? ` (Request ID: ${err.requestId})` : '';
      setLoadError(`${err.message}${reqSuffix}`);
    } else if (err instanceof Error) {
      setLoadError(err.message);
    } else {
      setLoadError('Unable to load your student admissions profile.');
    }
  }, []);

  const handleRetryLoad = useCallback(async () => {
    setIsLoading(true);
    setLoadError(null);
    setSaveError(null);

    try {
      const dto = await loadStudentProfileWithAuth(getAccessToken);
      const nextForm = toStudentProfileFormState(dto);
      setSavedProfile(dto);
      setFormState(nextForm);
      setSavedSnapshotJson(JSON.stringify(buildRawStudentProfilePayload(nextForm)));
    } catch (err: unknown) {
      applyLoadFailure(err);
    } finally {
      setIsLoading(false);
    }
  }, [applyLoadFailure, getAccessToken]);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const dto = await loadStudentProfileWithAuth(getAccessToken);
        if (cancelled) return;
        const nextForm = toStudentProfileFormState(dto);
        setSavedProfile(dto);
        setFormState(nextForm);
        setSavedSnapshotJson(JSON.stringify(buildRawStudentProfilePayload(nextForm)));
        setLoadError(null);
      } catch (err: unknown) {
        if (cancelled) return;
        applyLoadFailure(err);
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [applyLoadFailure, getAccessToken]);

  const hasUnsavedChanges = useMemo(() => {
    if (!formState) return false;
    return JSON.stringify(buildRawStudentProfilePayload(formState)) !== savedSnapshotJson;
  }, [formState, savedSnapshotJson]);

  const completion = useMemo(() => {
    if (!formState) {
      return savedProfile?.completion ?? {
        completedSections: 0,
        totalSections: 4,
        percentage: 0,
        isComplete: false,
        missingItems: [],
      };
    }
    return estimateFormCompletion(formState);
  }, [formState, savedProfile]);

  const toggleTargetCountry = (code: string) => {
    if (!formState) return;
    const current = parseTargetCountryCodes(formState.admissions.targetCountriesInput);
    const exists = current.includes(code);
    const next = exists ? current.filter((c) => c !== code) : [...current, code];
    setFormState({
      ...formState,
      admissions: {
        ...formState.admissions,
        targetCountriesInput: next.join(', '),
      },
    });
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!formState || isSaving) return;

    setValidationErrors([]);
    setSaveError(null);
    setSaveSuccessNotice(null);

    const validated = validateStudentProfileForm(formState);
    if (!validated.ok) {
      setValidationErrors(validated.errors);
      return;
    }

    setIsSaving(true);
    try {
      const updated = await updateStudentProfileWithAuth(getAccessToken, validated.data);
      const nextForm = toStudentProfileFormState(updated);
      setSavedProfile(updated);
      setFormState(nextForm);
      setSavedSnapshotJson(JSON.stringify(buildRawStudentProfilePayload(nextForm)));
      setSaveSuccessNotice(
        `Saved to PostgreSQL (${updated.completion.percentage}% readiness complete).`,
      );
    } catch (err: unknown) {
      if (isApiClientError(err)) {
        if (err.code === 'VALIDATION_ERROR' && Array.isArray(err.details)) {
          const detailMessages = err.details
            .map((d) => {
              const item = d as { path?: string; message?: string };
              return item.path ? `${item.path}: ${item.message ?? 'Invalid value'}` : item.message;
            })
            .filter((msg): msg is string => Boolean(msg));
          if (detailMessages.length > 0) {
            setValidationErrors(detailMessages);
            return;
          }
        }
        const reqSuffix = err.requestId ? ` (Request ID: ${err.requestId})` : '';
        setSaveError(`${err.message}${reqSuffix}`);
      } else if (err instanceof Error) {
        setSaveError(err.message);
      } else {
        setSaveError('Failed to save your admissions profile.');
      }
    } finally {
      setIsSaving(false);
    }
  };

  if (isLoading) {
    return (
      <section
        aria-busy="true"
        aria-label="Loading student admissions profile"
        className="rounded-lg border border-slate-200 bg-white p-6"
      >
        <div className="flex items-center gap-2.5 text-sm font-medium text-slate-700">
          <Loader2 className="h-4 w-4 animate-spin text-blue-700" />
          <span>Loading your admissions profile & academic readiness...</span>
        </div>
        <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-3">
          <div className="h-24 animate-pulse rounded-md border border-slate-200 bg-slate-50" />
          <div className="h-24 animate-pulse rounded-md border border-slate-200 bg-slate-50" />
          <div className="h-24 animate-pulse rounded-md border border-slate-200 bg-slate-50" />
        </div>
      </section>
    );
  }

  if (loadError || !formState || !savedProfile) {
    return (
      <section className="rounded-lg border border-red-200 bg-white p-6">
        <div className="flex items-start gap-3">
          <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-red-700" />
          <div className="space-y-2">
            <h2 className="text-sm font-semibold text-slate-950">
              Could not load student profile
            </h2>
            <p className="text-xs leading-relaxed text-red-800">
              {loadError ?? 'Unexpected profile loading failure.'}
            </p>
            <button
              type="button"
              onClick={() => void handleRetryLoad()}
              className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-900 hover:bg-slate-50"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              <span>Retry loading profile</span>
            </button>
          </div>
        </div>
      </section>
    );
  }

  const selectedTargetCountries = parseTargetCountryCodes(
    formState.admissions.targetCountriesInput,
  );
  const ieltsReported = formState.ielts.scoreStatus === 'reported';
  const ieltsLocked = isSaving || formState.ielts.isVerified;

  return (
    <form onSubmit={(e) => void handleSubmit(e)} noValidate className="space-y-6">
      {/* Progress & Status Header */}
      <section className="rounded-lg border border-slate-200 bg-white p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-base font-semibold text-slate-950">
                Student Admissions Profile & Readiness
              </h2>
              <span
                className={`rounded border px-2 py-0.5 font-mono text-[11px] font-medium ${
                  hasUnsavedChanges
                    ? 'border-amber-200 bg-amber-50 text-amber-900'
                    : 'border-emerald-200 bg-emerald-50 text-emerald-900'
                }`}
              >
                {hasUnsavedChanges ? 'Unsaved changes' : 'Saved'}
              </span>
            </div>
            <p className="mt-1 text-xs text-slate-600">
              Saved directly to your canonical Studexo student record. Incomplete profiles are
              welcome—save what you have now and refine anytime.
            </p>
          </div>

          <div className="text-right">
            <p className="font-mono text-xs font-semibold text-blue-700">
              {completion.percentage}% Complete ({completion.completedSections}/
              {completion.totalSections})
            </p>
            <p className="mt-0.5 text-[11px] text-slate-500">
              {savedProfile.admissions.updatedAt
                ? `Last saved ${new Date(savedProfile.admissions.updatedAt).toLocaleString()}`
                : 'Not saved yet'}
            </p>
          </div>
        </div>

        <div className="mt-4">
          <div className="h-2 w-full overflow-hidden rounded-full bg-slate-100">
            <div
              className="h-full rounded-full bg-blue-700 transition-all duration-300"
              style={{ width: `${completion.percentage}%` }}
            />
          </div>
          {completion.missingItems.length > 0 ? (
            <p className="mt-2 text-xs text-slate-600">
              Remaining for full readiness:{' '}
              <span className="font-medium text-slate-800">
                {completion.missingItems.join(' • ')}
              </span>
            </p>
          ) : (
            <p className="mt-2 flex items-center gap-1.5 text-xs font-medium text-emerald-800">
              <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
              <span>All core admissions, SSC/HSC, and IELTS readiness sections completed.</span>
            </p>
          )}
        </div>
      </section>

      {validationErrors.length > 0 ? (
        <div
          role="alert"
          className="rounded-lg border border-red-200 bg-red-50 p-4 text-xs text-red-900"
        >
          <div className="flex items-start gap-2.5">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-700" />
            <div>
              <p className="font-semibold">Please fix the following before saving:</p>
              <ul className="mt-1.5 list-disc space-y-1 pl-4">
                {validationErrors.map((err, idx) => (
                  <li key={idx}>{err}</li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      ) : null}

      {saveError ? (
        <div
          role="alert"
          className="flex items-start gap-2.5 rounded-lg border border-red-200 bg-red-50 p-4 text-xs text-red-900"
        >
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-700" />
          <span>{saveError}</span>
        </div>
      ) : null}

      {saveSuccessNotice ? (
        <div className="flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-xs font-medium text-emerald-900">
          <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-700" />
          <span>{saveSuccessNotice}</span>
        </div>
      ) : null}

      {/* Section A: Admissions Goals */}
      <section className="rounded-lg border border-slate-200 bg-white p-6">
        <div className="flex items-start gap-3 border-b border-slate-200 pb-4">
          <Compass className="mt-0.5 h-5 w-5 shrink-0 text-blue-700" />
          <div>
            <h2 className="text-sm font-semibold text-slate-950">A. Admissions Goals</h2>
            <p className="mt-0.5 text-xs text-slate-600">
              Location background, target degree level, destination countries, and funding plan.
            </p>
          </div>
        </div>

        <div className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <label htmlFor="adm-citizenship" className="block text-xs font-medium text-slate-700">
              Citizenship (ISO-2)
            </label>
            <input
              id="adm-citizenship"
              type="text"
              maxLength={2}
              disabled={isSaving}
              value={formState.admissions.countryOfCitizenship}
              onChange={(e) =>
                setFormState({
                  ...formState,
                  admissions: {
                    ...formState.admissions,
                    countryOfCitizenship: e.target.value.toUpperCase(),
                  },
                })
              }
              placeholder="BD or IN"
              className="mt-1 block w-full rounded-md border border-slate-300 bg-white px-3 py-2 font-mono text-sm uppercase text-slate-950 placeholder:text-slate-400 focus:border-blue-600 focus:outline-none"
            />
          </div>

          <div>
            <label htmlFor="adm-residence" className="block text-xs font-medium text-slate-700">
              Country of Residence (ISO-2)
            </label>
            <input
              id="adm-residence"
              type="text"
              maxLength={2}
              disabled={isSaving}
              value={formState.admissions.countryOfResidence}
              onChange={(e) =>
                setFormState({
                  ...formState,
                  admissions: {
                    ...formState.admissions,
                    countryOfResidence: e.target.value.toUpperCase(),
                  },
                })
              }
              placeholder="BD or IN"
              className="mt-1 block w-full rounded-md border border-slate-300 bg-white px-3 py-2 font-mono text-sm uppercase text-slate-950 placeholder:text-slate-400 focus:border-blue-600 focus:outline-none"
            />
          </div>

          <div>
            <label htmlFor="adm-city" className="block text-xs font-medium text-slate-700">
              City
            </label>
            <input
              id="adm-city"
              type="text"
              maxLength={120}
              disabled={isSaving}
              value={formState.admissions.city}
              onChange={(e) =>
                setFormState({
                  ...formState,
                  admissions: { ...formState.admissions, city: e.target.value },
                })
              }
              placeholder="e.g. Dhaka, Kolkata, Chattogram"
              className="mt-1 block w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-950 placeholder:text-slate-400 focus:border-blue-600 focus:outline-none"
            />
          </div>

          <div>
            <label htmlFor="adm-birth-year" className="block text-xs font-medium text-slate-700">
              Birth Year
            </label>
            <input
              id="adm-birth-year"
              type="number"
              min="1900"
              max="2100"
              disabled={isSaving}
              value={formState.admissions.birthYear}
              onChange={(e) =>
                setFormState({
                  ...formState,
                  admissions: { ...formState.admissions, birthYear: e.target.value },
                })
              }
              placeholder="e.g. 2005"
              className="mt-1 block w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-950 placeholder:text-slate-400 focus:border-blue-600 focus:outline-none"
            />
          </div>

          <div className="sm:col-span-2">
            <label htmlFor="adm-study-level" className="block text-xs font-medium text-slate-700">
              Target Study Level
            </label>
            <select
              id="adm-study-level"
              disabled={isSaving}
              value={formState.admissions.targetStudyLevel}
              onChange={(e) =>
                setFormState({
                  ...formState,
                  admissions: {
                    ...formState.admissions,
                    targetStudyLevel: e.target.value as '' | TargetStudyLevel,
                  },
                })
              }
              className="mt-1 block w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-950 focus:border-blue-600 focus:outline-none"
            >
              <option value="">Select study level...</option>
              {TARGET_STUDY_LEVELS.map((level) => (
                <option key={level} value={level}>
                  {STUDY_LEVEL_LABELS[level]}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label htmlFor="adm-intake" className="block text-xs font-medium text-slate-700">
              Target Intake
            </label>
            <input
              id="adm-intake"
              type="text"
              maxLength={32}
              disabled={isSaving}
              value={formState.admissions.targetIntakeTerm}
              onChange={(e) =>
                setFormState({
                  ...formState,
                  admissions: { ...formState.admissions, targetIntakeTerm: e.target.value },
                })
              }
              placeholder="e.g. Fall 2027"
              className="mt-1 block w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-950 placeholder:text-slate-400 focus:border-blue-600 focus:outline-none"
            />
          </div>

          <div>
            <label htmlFor="adm-field" className="block text-xs font-medium text-slate-700">
              Preferred Field of Study
            </label>
            <input
              id="adm-field"
              type="text"
              maxLength={160}
              disabled={isSaving}
              value={formState.admissions.preferredFieldOfStudy}
              onChange={(e) =>
                setFormState({
                  ...formState,
                  admissions: {
                    ...formState.admissions,
                    preferredFieldOfStudy: e.target.value,
                  },
                })
              }
              placeholder="e.g. Computer Science"
              className="mt-1 block w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-950 placeholder:text-slate-400 focus:border-blue-600 focus:outline-none"
            />
          </div>

          <div className="sm:col-span-2 lg:col-span-4">
            <span className="block text-xs font-medium text-slate-700">
              Destination Countries
            </span>
            <div className="mt-1.5 flex flex-wrap gap-2">
              {DESTINATION_PRESETS.map((preset) => {
                const active = selectedTargetCountries.includes(preset.code);
                return (
                  <button
                    key={preset.code}
                    type="button"
                    disabled={isSaving}
                    onClick={() => toggleTargetCountry(preset.code)}
                    className={`rounded-md border px-2.5 py-1 text-xs font-medium transition ${
                      active
                        ? 'border-blue-700 bg-blue-50 text-blue-900'
                        : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-50'
                    }`}
                  >
                    {preset.label}
                  </button>
                );
              })}
            </div>
            <input
              id="adm-target-countries"
              type="text"
              aria-label="Destination country ISO-2 codes (comma-separated)"
              disabled={isSaving}
              value={formState.admissions.targetCountriesInput}
              onChange={(e) =>
                setFormState({
                  ...formState,
                  admissions: {
                    ...formState.admissions,
                    targetCountriesInput: e.target.value.toUpperCase(),
                  },
                })
              }
              placeholder="Comma-separated ISO-2 codes (e.g. GB, CA, AU)"
              className="mt-2 block w-full rounded-md border border-slate-300 bg-white px-3 py-2 font-mono text-xs uppercase text-slate-950 placeholder:text-slate-400 focus:border-blue-600 focus:outline-none"
            />
          </div>

          <div>
            <label htmlFor="adm-budget" className="block text-xs font-medium text-slate-700">
              Annual Budget Amount
            </label>
            <input
              id="adm-budget"
              type="number"
              min="0"
              step="0.01"
              disabled={isSaving}
              value={formState.admissions.annualBudgetAmount}
              onChange={(e) =>
                setFormState({
                  ...formState,
                  admissions: {
                    ...formState.admissions,
                    annualBudgetAmount: e.target.value,
                  },
                })
              }
              placeholder="e.g. 20000"
              className="mt-1 block w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-950 placeholder:text-slate-400 focus:border-blue-600 focus:outline-none"
            />
          </div>

          <div>
            <label htmlFor="adm-currency" className="block text-xs font-medium text-slate-700">
              Budget Currency
            </label>
            <select
              id="adm-currency"
              disabled={isSaving}
              value={formState.admissions.annualBudgetCurrency}
              onChange={(e) =>
                setFormState({
                  ...formState,
                  admissions: {
                    ...formState.admissions,
                    annualBudgetCurrency: e.target.value,
                  },
                })
              }
              className="mt-1 block w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-950 focus:border-blue-600 focus:outline-none"
            >
              <option value="">Select currency...</option>
              {CURRENCY_OPTIONS.map((curr) => (
                <option key={curr} value={curr}>
                  {curr}
                </option>
              ))}
            </select>
          </div>

          <div className="sm:col-span-2">
            <label htmlFor="adm-funding" className="block text-xs font-medium text-slate-700">
              Funding Requirements
            </label>
            <select
              id="adm-funding"
              disabled={isSaving}
              value={formState.admissions.fundingNeed}
              onChange={(e) =>
                setFormState({
                  ...formState,
                  admissions: {
                    ...formState.admissions,
                    fundingNeed: e.target.value as '' | FundingNeed,
                  },
                })
              }
              className="mt-1 block w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-950 focus:border-blue-600 focus:outline-none"
            >
              <option value="">Select funding need...</option>
              {FUNDING_NEEDS.map((need) => (
                <option key={need} value={need}>
                  {FUNDING_NEED_LABELS[need]}
                </option>
              ))}
            </select>
          </div>
        </div>
      </section>

      {/* Section B: Academic Background (SSC & HSC) */}
      <section className="rounded-lg border border-slate-200 bg-white p-6">
        <div className="flex items-start gap-3 border-b border-slate-200 pb-4">
          <BookOpen className="mt-0.5 h-5 w-5 shrink-0 text-blue-700" />
          <div>
            <h2 className="text-sm font-semibold text-slate-950">
              B. Academic Background (SSC & HSC)
            </h2>
            <p className="mt-0.5 text-xs text-slate-600">
              Secondary (SSC / Class 10 / O-Level) and Higher Secondary (HSC / Class 12 / A-Level)
              board qualifications.
            </p>
          </div>
        </div>

        <div className="mt-5 space-y-4">
          <QualificationSectionCard
            idPrefix="ssc"
            title="SSC / Secondary Qualification"
            subtitle="Class 10, SSC, Dakhil, CBSE/ICSE 10th, or O-Level record."
            value={formState.ssc}
            gradingScales={savedProfile.gradingScales}
            disabled={isSaving}
            onChange={(nextSsc) => setFormState({ ...formState, ssc: nextSsc })}
          />

          <QualificationSectionCard
            idPrefix="hsc"
            title="HSC / Higher Secondary Qualification"
            subtitle="Class 12, HSC, Alim, CBSE/State 12th, or A-Level record."
            value={formState.hsc}
            gradingScales={savedProfile.gradingScales}
            disabled={isSaving}
            onChange={(nextHsc) => setFormState({ ...formState, hsc: nextHsc })}
          />
        </div>
      </section>

      {/* Section C: English Readiness (IELTS) */}
      <section className="rounded-lg border border-slate-200 bg-white p-6">
        <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-200 pb-4">
          <div className="flex items-start gap-3">
            <Globe2 className="mt-0.5 h-5 w-5 shrink-0 text-blue-700" />
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-sm font-semibold text-slate-950">
                  C. English Readiness (IELTS)
                </h2>
                {formState.ielts.enabled ? (
                  <span
                    className={`rounded border px-2 py-0.5 font-mono text-[11px] font-medium ${
                      formState.ielts.isVerified
                        ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
                        : 'border-slate-200 bg-slate-50 text-slate-700'
                    }`}
                  >
                    {formState.ielts.isVerified ? 'Verified' : 'Self-reported'}
                  </span>
                ) : null}
              </div>
              <p className="mt-0.5 text-xs text-slate-600">
                Current IELTS status, official/self-reported band scores, or planned exam date.
              </p>
            </div>
          </div>

          <label className="inline-flex cursor-pointer items-center gap-2 text-xs font-medium text-slate-800">
            <input
              type="checkbox"
              checked={formState.ielts.enabled}
              disabled={ieltsLocked}
              onChange={(e) =>
                setFormState({
                  ...formState,
                  ielts: { ...formState.ielts, enabled: e.target.checked },
                })
              }
              className="h-4 w-4 rounded border-slate-300 text-blue-700 focus:ring-blue-600"
            />
            <span>Track IELTS status</span>
          </label>
        </div>

        {formState.ielts.enabled ? (
          <div className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <div className="sm:col-span-2">
              <label htmlFor="ielts-status" className="block text-xs font-medium text-slate-700">
                IELTS Status
              </label>
              <select
                id="ielts-status"
                disabled={ieltsLocked}
                value={formState.ielts.scoreStatus}
                onChange={(e) => {
                  const nextStatus = e.target.value as IeltsScoreStatus;
                  setFormState({
                    ...formState,
                    ielts: {
                      ...formState.ielts,
                      scoreStatus: nextStatus,
                      ...(nextStatus !== 'reported'
                        ? {
                            overallScore: '',
                            listening: '',
                            reading: '',
                            writing: '',
                            speaking: '',
                          }
                        : {}),
                    },
                  });
                }}
                className="mt-1 block w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-950 focus:border-blue-600 focus:outline-none disabled:bg-slate-100"
              >
                {IELTS_SCORE_STATUSES.map((st) => (
                  <option key={st} value={st}>
                    {IELTS_STATUS_LABELS[st]}
                  </option>
                ))}
              </select>
            </div>

            {formState.ielts.scoreStatus === 'planned' ? (
              <div className="sm:col-span-2">
                <label
                  htmlFor="ielts-planned-date"
                  className="block text-xs font-medium text-slate-700"
                >
                  Planned Test Date
                </label>
                <input
                  id="ielts-planned-date"
                  type="date"
                  disabled={ieltsLocked}
                  value={formState.ielts.plannedTestDate}
                  onChange={(e) =>
                    setFormState({
                      ...formState,
                      ielts: { ...formState.ielts, plannedTestDate: e.target.value },
                    })
                  }
                  className="mt-1 block w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-950 focus:border-blue-600 focus:outline-none disabled:bg-slate-100"
                />
              </div>
            ) : null}

            {formState.ielts.scoreStatus === 'taken_pending_result' || ieltsReported ? (
              <div className="sm:col-span-2">
                <label
                  htmlFor="ielts-test-date"
                  className="block text-xs font-medium text-slate-700"
                >
                  Test Date
                </label>
                <input
                  id="ielts-test-date"
                  type="date"
                  disabled={ieltsLocked}
                  value={formState.ielts.testDate}
                  onChange={(e) =>
                    setFormState({
                      ...formState,
                      ielts: { ...formState.ielts, testDate: e.target.value },
                    })
                  }
                  className="mt-1 block w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-950 focus:border-blue-600 focus:outline-none disabled:bg-slate-100"
                />
              </div>
            ) : null}

            {formState.ielts.scoreStatus === 'waived' ? (
              <div className="sm:col-span-2 lg:col-span-4">
                <label
                  htmlFor="ielts-waiver-reason"
                  className="block text-xs font-medium text-slate-700"
                >
                  Waiver / Exemption Reason <span className="text-red-600">*</span>
                </label>
                <input
                  id="ielts-waiver-reason"
                  type="text"
                  maxLength={500}
                  disabled={ieltsLocked}
                  value={formState.ielts.waiverReason}
                  onChange={(e) =>
                    setFormState({
                      ...formState,
                      ielts: { ...formState.ielts, waiverReason: e.target.value },
                    })
                  }
                  placeholder="e.g. English-medium Bachelor’s (MOI letter available)"
                  className="mt-1 block w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-950 placeholder:text-slate-400 focus:border-blue-600 focus:outline-none disabled:bg-slate-100"
                />
              </div>
            ) : null}

            {ieltsReported ? (
              <>
                <div>
                  <label
                    htmlFor="ielts-overall"
                    className="block text-xs font-medium text-slate-700"
                  >
                    Overall Band (0.0–9.0) <span className="text-red-600">*</span>
                  </label>
                  <input
                    id="ielts-overall"
                    type="number"
                    min="0"
                    max="9"
                    step="0.5"
                    disabled={ieltsLocked}
                    value={formState.ielts.overallScore}
                    onChange={(e) =>
                      setFormState({
                        ...formState,
                        ielts: { ...formState.ielts, overallScore: e.target.value },
                      })
                    }
                    placeholder="e.g. 7.0"
                    className="mt-1 block w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-950 placeholder:text-slate-400 focus:border-blue-600 focus:outline-none disabled:bg-slate-100"
                  />
                </div>

                <div>
                  <label
                    htmlFor="ielts-listening"
                    className="block text-xs font-medium text-slate-700"
                  >
                    Listening
                  </label>
                  <input
                    id="ielts-listening"
                    type="number"
                    min="0"
                    max="9"
                    step="0.5"
                    disabled={ieltsLocked}
                    value={formState.ielts.listening}
                    onChange={(e) =>
                      setFormState({
                        ...formState,
                        ielts: { ...formState.ielts, listening: e.target.value },
                      })
                    }
                    placeholder="e.g. 7.5"
                    className="mt-1 block w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-950 placeholder:text-slate-400 focus:border-blue-600 focus:outline-none disabled:bg-slate-100"
                  />
                </div>

                <div>
                  <label
                    htmlFor="ielts-reading"
                    className="block text-xs font-medium text-slate-700"
                  >
                    Reading
                  </label>
                  <input
                    id="ielts-reading"
                    type="number"
                    min="0"
                    max="9"
                    step="0.5"
                    disabled={ieltsLocked}
                    value={formState.ielts.reading}
                    onChange={(e) =>
                      setFormState({
                        ...formState,
                        ielts: { ...formState.ielts, reading: e.target.value },
                      })
                    }
                    placeholder="e.g. 7.0"
                    className="mt-1 block w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-950 placeholder:text-slate-400 focus:border-blue-600 focus:outline-none disabled:bg-slate-100"
                  />
                </div>

                <div>
                  <label
                    htmlFor="ielts-writing"
                    className="block text-xs font-medium text-slate-700"
                  >
                    Writing
                  </label>
                  <input
                    id="ielts-writing"
                    type="number"
                    min="0"
                    max="9"
                    step="0.5"
                    disabled={ieltsLocked}
                    value={formState.ielts.writing}
                    onChange={(e) =>
                      setFormState({
                        ...formState,
                        ielts: { ...formState.ielts, writing: e.target.value },
                      })
                    }
                    placeholder="e.g. 6.5"
                    className="mt-1 block w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-950 placeholder:text-slate-400 focus:border-blue-600 focus:outline-none disabled:bg-slate-100"
                  />
                </div>

                <div>
                  <label
                    htmlFor="ielts-speaking"
                    className="block text-xs font-medium text-slate-700"
                  >
                    Speaking
                  </label>
                  <input
                    id="ielts-speaking"
                    type="number"
                    min="0"
                    max="9"
                    step="0.5"
                    disabled={ieltsLocked}
                    value={formState.ielts.speaking}
                    onChange={(e) =>
                      setFormState({
                        ...formState,
                        ielts: { ...formState.ielts, speaking: e.target.value },
                      })
                    }
                    placeholder="e.g. 7.0"
                    className="mt-1 block w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-950 placeholder:text-slate-400 focus:border-blue-600 focus:outline-none disabled:bg-slate-100"
                  />
                </div>
              </>
            ) : null}
          </div>
        ) : (
          <p className="mt-4 text-xs text-slate-500">
            Optional: enable IELTS tracking when you want to record your current band score or
            planned test date.
          </p>
        )}
      </section>

      {/* Action Footer */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-slate-200 bg-white px-6 py-4">
        <div className="flex items-center gap-2 text-xs text-slate-600">
          <ShieldCheck className="h-4 w-4 shrink-0 text-slate-600" />
          <span>
            Credentials saved here are marked <span className="font-mono">self_reported</span> until
            attested by a verified document or counselor.
          </span>
        </div>

        <div className="flex items-center gap-2.5">
          {hasUnsavedChanges ? (
            <button
              type="button"
              disabled={isSaving}
              onClick={() => {
                if (savedProfile) {
                  setFormState(toStudentProfileFormState(savedProfile));
                  setValidationErrors([]);
                  setSaveError(null);
                }
              }}
              className="inline-flex items-center whitespace-nowrap shrink-0 rounded-md border border-slate-300 bg-white px-3.5 py-2 text-xs font-medium text-slate-800 hover:bg-slate-50 disabled:opacity-60"
            >
              Discard changes
            </button>
          ) : null}

          <button
            type="submit"
            disabled={isSaving}
            className="inline-flex items-center gap-2 whitespace-nowrap shrink-0 rounded-md bg-blue-700 px-5 py-2 text-xs font-medium text-white hover:bg-blue-800 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isSaving ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Save className="h-4 w-4" />
            )}
            <span>{isSaving ? 'Saving...' : 'Save profile'}</span>
          </button>
        </div>
      </div>
    </form>
  );
}
