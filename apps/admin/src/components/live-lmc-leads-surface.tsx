"use client";

import { useRef, useState } from "react";
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { selectActiveBusiness } from "@/lib/active-business";
import { requestJson } from "@/lib/request-json";

type Business = { businessId: string; active: boolean; role: string };
type Lead = {
  id: string;
  name: string;
  email: string;
  subject: string;
  status: string;
  aiPaused: boolean;
  consentFollowups: boolean;
  followupCount: number;
  qualification: Record<string, string | null>;
  updatedAt: string;
};
type Message = {
  id: string;
  direction: string;
  body: string;
  status: string;
  createdAt: string;
};
type Detail = {
  lead: Lead;
  messages: Message[];
  role: string;
  nextBefore: string | null;
};
const canReply = (role: string) =>
  ["scheduler", "business_admin", "business_owner", "platform_admin"].includes(
    role,
  );

export function LiveLmcLeadsSurface() {
  const { t } = useTranslation("lmc");
  const businesses = useQuery({
    queryKey: ["businesses"],
    queryFn: ({ signal }) =>
      requestJson<{ businesses: Business[] }>("/api/businesses", { signal }),
  });
  const business = selectActiveBusiness(businesses.data?.businesses);
  if (businesses.isError) return <p role="alert">{t("loadFailed")}</p>;
  if (!business)
    return (
      <p role="status">{t(businesses.isPending ? "loading" : "noWorkspace")}</p>
    );
  return <LeadWorkspace key={business.businessId} business={business} />;
}

function LeadWorkspace({ business }: { business: Business }) {
  const { t, i18n } = useTranslation("lmc");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const list = useQuery({
    queryKey: ["lmc-leads", business.businessId, search, page],
    queryFn: ({ signal }) =>
      requestJson<{
        items: Lead[];
        summary: Record<string, number>;
        hasNext: boolean;
        role: string;
      }>(
        `/api/leads?businessId=${encodeURIComponent(business.businessId)}&limit=25&offset=${page * 25}&search=${encodeURIComponent(search)}`,
        { signal },
      ),
    refetchInterval: 10_000,
  });
  const summary = list.isError ? {} : (list.data?.summary ?? {});
  return (
    <div className="ph-no-capture flex flex-col gap-6">
      <PageHeader title={t("title")} />
      <div className="grid gap-4 sm:grid-cols-3">
        {[
          ["total", Object.values(summary).reduce((a, b) => a + b, 0)],
          ["booked", summary.booked ?? 0],
          ["attention", summary.human_handoff ?? 0],
        ].map(([label, count]) => (
          <Card key={label}>
            <CardContent>
              <p className="text-muted-foreground">{t(String(label))}</p>
              <p className="mt-2 text-2xl font-semibold">
                {Number(count).toLocaleString(i18n.language)}
              </p>
            </CardContent>
          </Card>
        ))}
      </div>
      <div className="grid items-start gap-6 lg:grid-cols-[minmax(16rem,1fr)_minmax(0,2fr)]">
        <Card>
          <CardContent className="flex flex-col gap-4">
            <Input
              aria-label={t("search")}
              placeholder={t("search")}
              maxLength={200}
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
                setPage(0);
              }}
            />
            {list.isError ? (
              <p role="alert">{t("loadFailed")}</p>
            ) : list.isPending ? (
              <p role="status">{t("loading")}</p>
            ) : (
              <>
                {list.data.items.length === 0 && <p>{t("empty")}</p>}
                {list.data.items.map((lead) => (
                  <div className="rounded-xl border p-4" key={lead.id}>
                    <Button
                      variant="link"
                      className="h-auto max-w-full justify-start truncate p-0"
                      onClick={() => setSelected(lead.id)}
                      aria-pressed={selected === lead.id}
                    >
                      {lead.name || lead.email}
                    </Button>
                    <p className="mt-1 truncate text-sm text-muted-foreground">
                      {lead.subject}
                    </p>
                    <Badge className="mt-2" variant="secondary">
                      {t(`statuses.${lead.status}`)}
                    </Badge>
                  </div>
                ))}
                <div className="flex justify-between gap-2">
                  <Button
                    variant="outline"
                    disabled={page === 0}
                    onClick={() => setPage((value) => value - 1)}
                  >
                    {t("previous")}
                  </Button>
                  <Button
                    variant="outline"
                    disabled={!list.data.hasNext}
                    onClick={() => setPage((value) => value + 1)}
                  >
                    {t("next")}
                  </Button>
                </div>
              </>
            )}
          </CardContent>
        </Card>
        {selected ? (
          <LeadConversation key={selected} business={business} id={selected} />
        ) : (
          <Card>
            <CardContent className="text-muted-foreground">
              {t("selectLead")}
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}

function LeadConversation({
  business,
  id,
}: {
  business: Business;
  id: string;
}) {
  const { t, i18n } = useTranslation("lmc");
  const client = useQueryClient();
  const [draft, setDraft] = useState("");
  const pending = useRef<{ requestId: string; text: string } | null>(null);
  const url = `/api/leads/${encodeURIComponent(id)}`;
  const workspace = `businessId=${encodeURIComponent(business.businessId)}`;
  const detail = useInfiniteQuery({
    queryKey: ["lmc-lead", business.businessId, id],
    initialPageParam: null as string | null,
    queryFn: ({ signal, pageParam }) =>
      requestJson<Detail>(
        `${url}?${workspace}${pageParam ? `&before=${encodeURIComponent(pageParam)}` : ""}`,
        { signal },
      ),
    getNextPageParam: (page) => page.nextBefore ?? undefined,
    refetchInterval: 5_000,
  });
  const refresh = async () => {
    await Promise.all([
      client.invalidateQueries({
        queryKey: ["lmc-lead", business.businessId, id],
      }),
      client.invalidateQueries({
        queryKey: ["lmc-leads", business.businessId],
      }),
    ]);
  };
  const send = useMutation({
    mutationFn: () => {
      if (!pending.current || pending.current.text !== draft.trim())
        pending.current = {
          requestId: crypto.randomUUID(),
          text: draft.trim(),
        };
      return requestJson(`${url}/reply?${workspace}`, {
        method: "POST",
        body: JSON.stringify(pending.current),
      });
    },
    onSuccess: async () => {
      setDraft("");
      pending.current = null;
      await refresh();
    },
  });
  const pause = useMutation({
    mutationFn: (paused: boolean) =>
      requestJson(`${url}/automation?${workspace}`, {
        method: "PATCH",
        body: JSON.stringify({ paused }),
      }),
    onSuccess: refresh,
  });
  if (detail.isError) return <p role="alert">{t("loadFailed")}</p>;
  const data = detail.data?.pages[0];
  if (!data) return <p role="status">{t("loading")}</p>;
  const lead = data.lead;
  const allowed =
    canReply(data.role) && !["opted_out", "suppressed"].includes(lead.status);
  const messages = [
    ...new Map(
      detail
        .data!.pages.flatMap((page) => page.messages)
        .map((message) => [message.id, message]),
    ).values(),
  ].sort(
    (a, b) =>
      a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
  );
  return (
    <Card>
      <CardContent className="flex min-w-0 flex-col gap-4">
        <div>
          <h2 className="break-words text-lg font-semibold">
            {lead.name || lead.email}
          </h2>
          <p className="break-all text-muted-foreground">{lead.email}</p>
          <Badge className="mt-2" variant="secondary">
            {t(`statuses.${lead.status}`)}
          </Badge>
        </div>
        <dl className="grid gap-2 sm:grid-cols-2">
          {Object.entries(lead.qualification)
            .filter(([, value]) => value)
            .map(([key, value]) => (
              <div key={key}>
                <dt className="text-sm text-muted-foreground">
                  {t(`fields.${key}`)}
                </dt>
                <dd className="break-words">{value}</dd>
              </div>
            ))}
        </dl>
        <p className="text-sm text-muted-foreground">
          {t(lead.consentFollowups ? "consented" : "notConsented", {
            count: lead.followupCount,
          })}
        </p>
        <p className="text-sm">
          {t(lead.aiPaused ? "paused" : "active")}{" "}
          {lead.aiPaused && t("resumeHelp")}
        </p>
        {allowed && (
          <Button
            className="self-start"
            variant="outline"
            disabled={pause.isPending}
            onClick={() => pause.mutate(!lead.aiPaused)}
          >
            {t(lead.aiPaused ? "resume" : "pause")}
          </Button>
        )}
        {pause.isError && <p role="alert">{t("pauseFailed")}</p>}
        {detail.hasNextPage && (
          <Button
            variant="outline"
            disabled={detail.isFetching}
            onClick={() => void detail.fetchNextPage()}
          >
            {t("earlier")}
          </Button>
        )}
        <ol className="flex flex-col gap-4">
          {messages.map((message) => (
            <li className="rounded-xl border p-4" key={message.id}>
              <div className="mb-2 flex flex-wrap justify-between gap-2 text-xs text-muted-foreground">
                <span>
                  {t(`directions.${message.direction}`)} ·{" "}
                  {t(`delivery.${message.status}`)}
                </span>
                <time dateTime={message.createdAt}>
                  {new Intl.DateTimeFormat(i18n.language, {
                    dateStyle: "medium",
                    timeStyle: "short",
                  }).format(new Date(message.createdAt))}
                </time>
              </div>
              <p className="whitespace-pre-wrap break-words">{message.body}</p>
            </li>
          ))}
        </ol>
        {allowed && (
          <form
            className="flex flex-col gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              if (draft.trim() && !send.isPending) send.mutate();
            }}
          >
            <label htmlFor="lmc-human-reply">{t("reply")}</label>
            <Textarea
              id="lmc-human-reply"
              maxLength={8000}
              value={draft}
              disabled={send.isPending}
              onChange={(event) => {
                setDraft(event.target.value);
                send.reset();
              }}
            />
            <p className="text-sm text-muted-foreground">{t("replyHelp")}</p>
            <Button
              className="self-start"
              disabled={send.isPending || !draft.trim()}
              type="submit"
            >
              {t("send")}
            </Button>
            {send.isError && <p role="alert">{t("sendFailed")}</p>}
            {send.isSuccess && <p role="status">{t("queued")}</p>}
          </form>
        )}
      </CardContent>
    </Card>
  );
}
