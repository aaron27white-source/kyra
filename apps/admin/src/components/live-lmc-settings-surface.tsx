"use client";

import Link from "next/link";
import { useState, type ReactNode } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { LmcBusinessSettings } from "@lobbystack/contracts";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { selectActiveBusiness } from "@/lib/active-business";
import { requestJson } from "@/lib/request-json";
import { createLmcFormSnippet } from "@/lib/lmc-form-snippet";

type Settings = {
  config: LmcBusinessSettings | null;
  enabled: boolean;
  catalog: { id: string; name: string }[];
  senderEmail: string;
  role: string;
  providerMode: string;
};
const split = (text: string) =>
  text
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

export function LiveLmcSettingsSurface() {
  const { t } = useTranslation("lmc");
  const businesses = useQuery({
    queryKey: ["businesses"],
    queryFn: ({ signal }) =>
      requestJson<{ businesses: { businessId: string; active: boolean }[] }>(
        "/api/businesses",
        { signal },
      ),
  });
  const business = selectActiveBusiness(businesses.data?.businesses);
  if (businesses.isError) return <p role="alert">{t("loadFailed")}</p>;
  if (!business)
    return (
      <p role="status">{t(businesses.isPending ? "loading" : "noWorkspace")}</p>
    );
  return (
    <EmailSettings key={business.businessId} businessId={business.businessId} />
  );
}

function EmailSettings({ businessId }: { businessId: string }) {
  const { t } = useTranslation("lmc");
  const settings = useQuery({
    queryKey: ["lmc-settings", businessId],
    queryFn: ({ signal }) =>
      requestJson<Settings>(
        `/api/lmc/settings?businessId=${encodeURIComponent(businessId)}`,
        { signal },
      ),
  });
  if (settings.isError) return <p role="alert">{t("loadFailed")}</p>;
  if (!settings.data) return <p role="status">{t("loading")}</p>;
  return <SettingsForm businessId={businessId} initial={settings.data} />;
}

function SettingsForm({
  businessId,
  initial,
}: {
  businessId: string;
  initial: Settings;
}) {
  const { t } = useTranslation("lmc");
  const [config, setConfig] = useState<LmcBusinessSettings>(
    () =>
      initial.config ?? {
        ownerEmail: "",
        fromEmail: initial.senderEmail,
        physicalAddress: "",
        serviceAreaZips: [],
        serviceAreaCities: [],
        services: [],
        emergencyKeywords: ["active leak", "storm damage"],
        emergencyText: "",
        priceInformation: "",
        tone: "professional",
        confidenceThreshold: 0.8,
        tools: ["availability", "book", "reschedule", "cancel", "handoff"],
        followups: {
          enabled: false,
          maxTouches: 3,
          delaysHours: [24, 72, 168],
          dailyCap: 100,
        },
      },
  );
  const [enabled, setEnabled] = useState(initial.enabled);
  const [zips, setZips] = useState(config.serviceAreaZips.join(", "));
  const [cities, setCities] = useState(config.serviceAreaCities.join(", "));
  const [keywords, setKeywords] = useState(config.emergencyKeywords.join(", "));
  const [delays, setDelays] = useState(config.followups.delaysHours.join(", "));
  const [captureToken, setCaptureToken] = useState<string | null>(null);
  const [confirmRotate, setConfirmRotate] = useState(false);
  const [configured, setConfigured] = useState(Boolean(initial.config));
  const [saved, setSaved] = useState(false);
  const admin = ["business_admin", "business_owner", "platform_admin"].includes(
    initial.role,
  );
  const endpoint = `/api/lmc/settings?businessId=${encodeURIComponent(businessId)}`;
  const save = useMutation({
    mutationFn: () =>
      requestJson<{ captureToken?: string }>(endpoint, {
        method: "PUT",
        body: JSON.stringify({
          enabled,
          config: {
            ...config,
            fromEmail: initial.senderEmail,
            serviceAreaZips: split(zips),
            serviceAreaCities: split(cities),
            emergencyKeywords: split(keywords),
            followups: {
              ...config.followups,
              delaysHours: split(delays).map(Number),
            },
          },
        }),
      }),
    onSuccess: (result) => {
      setSaved(true);
      setConfigured(true);
      if (result.captureToken) setCaptureToken(result.captureToken);
    },
  });
  const rotate = useMutation({
    mutationFn: () =>
      requestJson<{ captureToken: string }>(
        `/api/lmc/settings/capture-token?businessId=${encodeURIComponent(businessId)}`,
        { method: "POST" },
      ),
    onSuccess: (result) => {
      setCaptureToken(result.captureToken);
      setConfirmRotate(false);
    },
  });
  const update = <K extends keyof LmcBusinessSettings>(
    key: K,
    value: LmcBusinessSettings[K],
  ) => {
    setConfig((current) => ({ ...current, [key]: value }));
    setSaved(false);
  };
  const field = (name: string, input: ReactNode) => (
    <div className="flex flex-col gap-2">
      <label htmlFor={`email-${name}`}>{t(`emailSettings.${name}`)}</label>
      {input}
    </div>
  );
  const followups = config.followups;
  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-xl font-semibold">{t("emailSettings.title")}</h1>
      {initial.providerMode === "fake" && (
        <p role="status" className="rounded-xl border bg-muted p-4">
          {t("emailSettings.fake")}
        </p>
      )}
      <p className="text-muted-foreground">{t("emailSettings.description")}</p>
      <form
        className="ph-no-capture"
        onSubmit={(event) => {
          event.preventDefault();
          if (admin && !save.isPending) save.mutate();
        }}
      >
        <fieldset
          disabled={!admin || save.isPending || rotate.isPending}
          className="flex flex-col gap-6"
        >
          <Card>
            <CardContent className="grid gap-4 sm:grid-cols-2">
              <label className="flex items-center gap-2 sm:col-span-2">
                <input
                  type="checkbox"
                  checked={enabled}
                  onChange={(event) => {
                    setEnabled(event.target.checked);
                    setSaved(false);
                  }}
                />
                {t("emailSettings.enabled")}
              </label>
              {field(
                "owner",
                <Input
                  id="email-owner"
                  type="email"
                  required
                  maxLength={320}
                  value={config.ownerEmail}
                  onChange={(event) => update("ownerEmail", event.target.value)}
                />,
              )}
              {field(
                "sender",
                <Input
                  id="email-sender"
                  readOnly
                  value={initial.senderEmail}
                />,
              )}
              <div className="sm:col-span-2">
                {field(
                  "address",
                  <Textarea
                    id="email-address"
                    required
                    minLength={10}
                    maxLength={500}
                    value={config.physicalAddress}
                    onChange={(event) =>
                      update("physicalAddress", event.target.value)
                    }
                  />,
                )}
              </div>
              {field(
                "zips",
                <Input
                  id="email-zips"
                  required
                  value={zips}
                  onChange={(event) => {
                    setZips(event.target.value);
                    setSaved(false);
                  }}
                />,
              )}
              {field(
                "cities",
                <Input
                  id="email-cities"
                  value={cities}
                  onChange={(event) => {
                    setCities(event.target.value);
                    setSaved(false);
                  }}
                />,
              )}
            </CardContent>
          </Card>
          <Card>
            <CardContent className="flex flex-col gap-4">
              <h2 className="font-semibold">{t("emailSettings.services")}</h2>
              <p className="text-sm text-muted-foreground">
                {t("emailSettings.catalogHelp")}
              </p>
              <Link className="underline" href="/agent/services">
                {t("emailSettings.manageServices")}
              </Link>
              {initial.catalog.length === 0 && (
                <p>{t("emailSettings.noServices")}</p>
              )}
              {initial.catalog.map((service) => {
                const selected = config.services.find(
                  (item) => item.id === service.id,
                );
                return (
                  <div
                    key={service.id}
                    className="flex flex-col gap-2 rounded-xl border p-4"
                  >
                    <label className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={Boolean(selected)}
                        onChange={(event) =>
                          update(
                            "services",
                            event.target.checked
                              ? [
                                  ...config.services,
                                  { ...service, aliases: [] },
                                ]
                              : config.services.filter(
                                  (item) => item.id !== service.id,
                                ),
                          )
                        }
                      />
                      {service.name}
                    </label>
                    {selected && (
                      <Aliases
                        key={service.id}
                        id={service.id}
                        value={selected.aliases}
                        onChange={(aliases) =>
                          update(
                            "services",
                            config.services.map((item) =>
                              item.id === service.id
                                ? { ...item, aliases }
                                : item,
                            ),
                          )
                        }
                      />
                    )}
                  </div>
                );
              })}
              {field(
                "keywords",
                <Input
                  id="email-keywords"
                  required
                  value={keywords}
                  onChange={(event) => {
                    setKeywords(event.target.value);
                    setSaved(false);
                  }}
                />,
              )}
              {field(
                "emergency",
                <Textarea
                  id="email-emergency"
                  required
                  minLength={20}
                  maxLength={2000}
                  value={config.emergencyText}
                  onChange={(event) =>
                    update("emergencyText", event.target.value)
                  }
                />,
              )}
              {field(
                "prices",
                <Textarea
                  id="email-prices"
                  maxLength={2000}
                  value={config.priceInformation}
                  onChange={(event) =>
                    update("priceInformation", event.target.value)
                  }
                />,
              )}
              {field(
                "tone",
                <select
                  id="email-tone"
                  className="rounded-xl border bg-background p-2"
                  value={config.tone}
                  onChange={(event) =>
                    update(
                      "tone",
                      event.target.value as LmcBusinessSettings["tone"],
                    )
                  }
                >
                  {["professional", "friendly", "concise"].map((value) => (
                    <option value={value} key={value}>
                      {t(`emailSettings.tones.${value}`)}
                    </option>
                  ))}
                </select>,
              )}
              {field(
                "confidence",
                <Input
                  id="email-confidence"
                  type="number"
                  required
                  min={0.5}
                  max={1}
                  step={0.05}
                  value={config.confidenceThreshold}
                  onChange={(event) =>
                    update("confidenceThreshold", Number(event.target.value))
                  }
                />,
              )}
              <h2 className="font-semibold">{t("emailSettings.tools")}</h2>
              {(
                [
                  "availability",
                  "book",
                  "reschedule",
                  "cancel",
                  "handoff",
                ] as const
              ).map((tool) => (
                <label key={tool} className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={config.tools.includes(tool)}
                    onChange={(event) =>
                      update(
                        "tools",
                        event.target.checked
                          ? [...config.tools, tool]
                          : config.tools.filter((item) => item !== tool),
                      )
                    }
                  />
                  {t(`emailSettings.toolNames.${tool}`)}
                </label>
              ))}
              <Link className="underline" href="/agent">
                {t("emailSettings.hoursHelp")}
              </Link>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="grid gap-4 sm:grid-cols-2">
              <label className="flex items-center gap-2 sm:col-span-2">
                <input
                  type="checkbox"
                  checked={followups.enabled}
                  onChange={(event) =>
                    update("followups", {
                      ...followups,
                      enabled: event.target.checked,
                    })
                  }
                />
                {t("emailSettings.followups")}
              </label>
              <p className="text-sm text-muted-foreground sm:col-span-2">
                {t("emailSettings.followupHelp")}
              </p>
              {field(
                "maxTouches",
                <Input
                  id="email-maxTouches"
                  type="number"
                  required
                  min={0}
                  max={3}
                  value={followups.maxTouches}
                  onChange={(event) =>
                    update("followups", {
                      ...followups,
                      maxTouches: Number(event.target.value),
                    })
                  }
                />,
              )}
              {field(
                "dailyCap",
                <Input
                  id="email-dailyCap"
                  type="number"
                  required
                  min={0}
                  max={1000}
                  value={followups.dailyCap}
                  onChange={(event) =>
                    update("followups", {
                      ...followups,
                      dailyCap: Number(event.target.value),
                    })
                  }
                />,
              )}
              {field(
                "delays",
                <Input
                  id="email-delays"
                  value={delays}
                  onChange={(event) => {
                    setDelays(event.target.value);
                    setSaved(false);
                  }}
                />,
              )}
            </CardContent>
          </Card>
          {admin && (
            <Button className="self-start" type="submit">
              {t("emailSettings.save")}
            </Button>
          )}
        </fieldset>
        {save.isError && (
          <p role="alert" className="mt-4">
            {t("emailSettings.saveFailed")}
          </p>
        )}
        {saved && (
          <p role="status" className="mt-4">
            {t("emailSettings.saved")}
          </p>
        )}
      </form>
      {admin && configured && (
        <Card>
          <CardContent className="flex flex-col gap-4">
            <h2 className="font-semibold">{t("emailSettings.capture")}</h2>
            <p>{t("emailSettings.tokenHelp")}</p>
            {captureToken && (
              <div className="ph-no-capture">
                <label htmlFor="email-capture-token">
                  {t("emailSettings.token")}
                </label>
                <Input id="email-capture-token" readOnly value={captureToken} />
                <label className="mt-4 block" htmlFor="email-capture-snippet">
                  {t("emailSettings.snippet")}
                </label>
                <Textarea
                  id="email-capture-snippet"
                  readOnly
                  spellCheck={false}
                  className="mt-2 font-mono text-sm"
                  value={createLmcFormSnippet(
                    window.location.origin,
                    captureToken,
                  )}
                />
                <p className="mt-2 text-sm text-muted-foreground">
                  {t("emailSettings.snippetHelp")}
                </p>
              </div>
            )}
            <label className="flex items-start gap-2">
              <input
                type="checkbox"
                checked={confirmRotate}
                onChange={(event) => setConfirmRotate(event.target.checked)}
              />
              {t("emailSettings.rotateWarning")}
            </label>
            <Button
              className="self-start"
              variant="outline"
              disabled={!confirmRotate || rotate.isPending || save.isPending}
              onClick={() => rotate.mutate()}
            >
              {t("emailSettings.rotate")}
            </Button>
            {rotate.isError && (
              <p role="alert">{t("emailSettings.rotateFailed")}</p>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function Aliases({
  id,
  value,
  onChange,
}: {
  id: string;
  value: string[];
  onChange: (aliases: string[]) => void;
}) {
  const { t } = useTranslation("lmc");
  const [text, setText] = useState(value.join(", "));
  return (
    <>
      <label
        htmlFor={`aliases-${id}`}
        className="text-sm text-muted-foreground"
      >
        {t("emailSettings.aliases")}
      </label>
      <Input
        id={`aliases-${id}`}
        value={text}
        onChange={(event) => {
          setText(event.target.value);
          onChange(split(event.target.value));
        }}
      />
    </>
  );
}
