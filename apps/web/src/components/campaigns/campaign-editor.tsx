'use client';

import {
  CAMPAIGN_BODY_MAX,
  CAMPAIGN_ROLE_FILTERS,
  isMediaMimeType,
  MEDIA_ACCEPT_ATTRIBUTE,
  mimeTypeFromFileName,
  type CampaignAudience,
  type CampaignDto,
  type ConversationSummaryDto,
  type MediaAssetDto,
  type StoreDto,
} from '@storeline/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FileUp, Paperclip, Trash2 } from 'lucide-react';
import { useRef, useState } from 'react';
import { api, errorMessage } from '@/lib/api';
import { useConversations } from '@/lib/chat-hooks';
import { uploadFile, type UploadProgress } from '@/lib/uploads';
import { Alert, Button, cx, TextArea, TextField } from '../ui';

const ROLE_LABEL: Record<(typeof CAMPAIGN_ROLE_FILTERS)[number], string> = {
  BUSINESS_OWNER: 'Business owners',
  BUSINESS_ADMIN: 'Business admins',
  BUSINESS_MANAGER: 'Business managers',
  STORE_MANAGER: 'Store managers',
  SECURITY: 'Security',
  EMPLOYEE: 'Employees',
};

function Check({
  checked,
  onChange,
  children,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  children: React.ReactNode;
}) {
  return (
    <label
      className={cx(
        'flex min-h-11 cursor-pointer items-center gap-3 rounded-xl border px-3',
        checked ? 'border-brand bg-brand-soft' : 'border-line-strong/50 hover:bg-surface-2',
      )}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="size-5 accent-[var(--brand)]"
      />
      <span className="min-w-0 flex-1 truncate">{children}</span>
    </label>
  );
}

const toggle = (list: string[], id: string, on: boolean) =>
  on ? [...new Set([...list, id])] : list.filter((x) => x !== id);

/** Creates or edits a draft. Attachments can be added once the draft exists. */
export function CampaignEditor({
  businessId,
  campaign,
  onSaved,
  onCancel,
}: {
  businessId: string;
  campaign: CampaignDto | null;
  onSaved: (campaign: CampaignDto) => void;
  onCancel: () => void;
}) {
  const client = useQueryClient();
  const key = useRef(crypto.randomUUID());
  const [name, setName] = useState(campaign?.name ?? '');
  const [description, setDescription] = useState(campaign?.description ?? '');
  const [body, setBody] = useState(campaign?.body ?? '');
  const [expiresAt, setExpiresAt] = useState(
    campaign?.expiresAt ? toLocalInput(campaign.expiresAt) : '',
  );
  const [audience, setAudience] = useState<CampaignAudience>(
    campaign?.audience ?? {
      everyone: true,
      storeIds: [],
      groupIds: [],
      roleKeys: [],
      includeCustomers: false,
    },
  );
  const stores = useQuery({
    queryKey: ['stores', businessId],
    queryFn: () => api<StoreDto[]>(`/businesses/${businessId}/stores`),
  });
  const conversations = useConversations();
  const groups = (conversations.data ?? []).filter(
    (c: ConversationSummaryDto) => c.type === 'GROUP' && c.businessId === businessId,
  );

  const save = useMutation({
    mutationFn: () => {
      const payload = {
        name: name.trim(),
        description: description.trim() || null,
        body: body.trim() || null,
        audience,
        expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
      };
      return campaign
        ? api<CampaignDto>(`/campaigns/${campaign.id}`, { method: 'PATCH', body: payload })
        : api<CampaignDto>('/campaigns', {
            method: 'POST',
            body: { ...payload, businessId, clientCampaignId: key.current },
          });
    },
    onSuccess: (saved) => {
      void client.invalidateQueries({ queryKey: ['campaigns', businessId] });
      client.setQueryData(['campaign', saved.id], saved);
      onSaved(saved);
    },
  });

  const anySegment =
    audience.everyone || audience.storeIds.length > 0 || audience.groupIds.length > 0;
  return (
    <form
      className="flex flex-col gap-5"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <section className="flex flex-col gap-4 rounded-3xl border border-line bg-surface p-5 shadow-card">
        <h2 className="text-xl font-bold">{campaign ? 'Edit draft' : 'New campaign'}</h2>
        <TextField
          label="Campaign name"
          hint="Only administrators see this name."
          value={name}
          maxLength={120}
          required
          onChange={(e) => setName(e.target.value)}
        />
        <TextField
          label="Internal note (optional)"
          value={description}
          maxLength={500}
          onChange={(e) => setDescription(e.target.value)}
        />
        <TextArea
          label="Message"
          hint={`What recipients will see. ${body.length}/${CAMPAIGN_BODY_MAX}`}
          value={body}
          maxLength={CAMPAIGN_BODY_MAX}
          rows={6}
          onChange={(e) => setBody(e.target.value)}
          placeholder="e.g. All stores close at 4 pm this Friday for the stock count."
        />
        {campaign ? (
          <CampaignAttachment campaign={campaign} />
        ) : (
          <p className="flex items-center gap-2 text-sm text-muted">
            <Paperclip className="size-4" aria-hidden /> Save the draft to add a photo, video or
            document.
          </p>
        )}
      </section>

      <section className="flex flex-col gap-4 rounded-3xl border border-line bg-surface p-5 shadow-card">
        <div>
          <h2 className="text-xl font-bold">Who receives it</h2>
          <p className="text-muted">
            Only people in this business. Each person gets it in their own read-only “Announcements”
            chat.
          </p>
        </div>
        <Check
          checked={audience.everyone}
          onChange={(v) => setAudience({ ...audience, everyone: v })}
        >
          <strong>Everyone</strong> in the business
        </Check>
        {!audience.everyone && (
          <>
            <fieldset className="flex flex-col gap-2">
              <legend className="mb-1 font-semibold">Stores</legend>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {(stores.data ?? [])
                  .filter((s) => s.status === 'ACTIVE')
                  .map((s) => (
                    <Check
                      key={s.id}
                      checked={audience.storeIds.includes(s.id)}
                      onChange={(v) =>
                        setAudience({ ...audience, storeIds: toggle(audience.storeIds, s.id, v) })
                      }
                    >
                      {s.name}
                    </Check>
                  ))}
              </div>
            </fieldset>
            {groups.length > 0 && (
              <fieldset className="flex flex-col gap-2">
                <legend className="mb-1 font-semibold">Groups you belong to</legend>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  {groups.map((g) => (
                    <Check
                      key={g.id}
                      checked={audience.groupIds.includes(g.id)}
                      onChange={(v) =>
                        setAudience({ ...audience, groupIds: toggle(audience.groupIds, g.id, v) })
                      }
                    >
                      {g.title}
                    </Check>
                  ))}
                </div>
              </fieldset>
            )}
          </>
        )}
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 font-semibold">Only people with these roles (optional)</legend>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {CAMPAIGN_ROLE_FILTERS.map((r) => (
              <Check
                key={r}
                checked={audience.roleKeys.includes(r)}
                onChange={(v) =>
                  setAudience({
                    ...audience,
                    roleKeys: toggle(audience.roleKeys, r, v) as CampaignAudience['roleKeys'],
                  })
                }
              >
                {ROLE_LABEL[r]}
              </Check>
            ))}
          </div>
        </fieldset>
        <Check
          checked={audience.includeCustomers}
          onChange={(v) => setAudience({ ...audience, includeCustomers: v })}
        >
          Include customers (they can opt out)
        </Check>
        <TextField
          label="Stop delivering after (optional)"
          hint="People not reached by this time are skipped, e.g. for time-limited offers."
          type="datetime-local"
          value={expiresAt}
          onChange={(e) => setExpiresAt(e.target.value)}
          className="max-w-xs"
        />
      </section>

      {save.error && <Alert tone="error">{errorMessage(save.error)}</Alert>}
      <div className="flex flex-wrap justify-end gap-3">
        <Button type="button" variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" busy={save.isPending} disabled={!name.trim() || !anySegment}>
          {campaign ? 'Save changes' : 'Save draft'}
        </Button>
      </div>
    </form>
  );
}

function CampaignAttachment({ campaign }: { campaign: CampaignDto }) {
  const client = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const [progress, setProgress] = useState<UploadProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const attach = useMutation({
    mutationFn: (mediaId: string | null) =>
      api<CampaignDto>(`/campaigns/${campaign.id}`, { method: 'PATCH', body: { mediaId } }),
    onSuccess: (saved) => client.setQueryData(['campaign', saved.id], saved),
  });

  const pick = async (file: File) => {
    setError(null);
    const mimeType = isMediaMimeType(file.type) ? file.type : mimeTypeFromFileName(file.name);
    if (!mimeType) return setError('This file type cannot be shared.');
    try {
      const media: MediaAssetDto = await uploadFile(
        file,
        { campaignId: campaign.id },
        mimeType,
        setProgress,
        new AbortController().signal,
      );
      await attach.mutateAsync(media.id);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setProgress(null);
    }
  };

  const media = campaign.media;
  return (
    <div className="flex flex-col gap-2">
      <span className="font-semibold">Attachment (optional)</span>
      {media ? (
        <div className="flex items-center gap-3 rounded-xl border border-line p-3">
          <Paperclip className="size-5 text-muted" aria-hidden />
          <span className="min-w-0 flex-1 truncate">{media.fileName}</span>
          <span className="text-sm text-muted">
            {media.status === 'READY' ? 'Checked' : 'Checking…'}
          </span>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            icon={<Trash2 className="size-4" aria-hidden />}
            onClick={() => attach.mutate(null)}
          >
            Remove
          </Button>
        </div>
      ) : (
        <div>
          <input
            ref={input}
            type="file"
            hidden
            accept={MEDIA_ACCEPT_ATTRIBUTE}
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (file) void pick(file);
            }}
          />
          <Button
            type="button"
            variant="secondary"
            busy={!!progress}
            icon={<FileUp className="size-5" aria-hidden />}
            onClick={() => input.current?.click()}
          >
            {progress
              ? progress.stage === 'checking'
                ? 'Safety check…'
                : `Uploading ${Math.round(progress.fraction * 100)}%`
              : 'Attach a file'}
          </Button>
        </div>
      )}
      {error && <Alert tone="error">{error}</Alert>}
    </div>
  );
}

function toLocalInput(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
