import type { EnvironmentId } from "@t3tools/contracts";
import { defaultBranchOptions } from "@t3tools/shared/git";
import { T, useGT } from "gt-react";
import { ChevronDownIcon } from "lucide-react";
import { useState } from "react";

import { usePaginatedBranches } from "../state/queries";
import { useEnvironmentQuery } from "../state/query";
import { vcsEnvironment } from "../state/vcs";
import { BranchPicker, BranchPickerRefItem } from "./BranchPicker";
import { MiddleTruncate } from "./ui/middle-truncate";
import { Button } from "./ui/button";
import { ComboboxItem, ComboboxTrigger } from "./ui/combobox";

export function DefaultBranchPicker(props: {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly value: string | null;
  readonly mixed: boolean;
  readonly onChange: (branch: string | null) => void;
}) {
  const gt = useGT();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const branches = usePaginatedBranches({
    environmentId: props.environmentId,
    cwd: props.cwd,
    query,
  });
  const selected = useEnvironmentQuery(
    props.value === null
      ? null
      : vcsEnvironment.listRefs({
          environmentId: props.environmentId,
          input: { cwd: props.cwd, query: props.value, limit: 100 },
        }),
  );
  const options = defaultBranchOptions(branches.refs, branches.data?.primaryRemoteName ?? null);
  const unavailable =
    props.value !== null &&
    selected.data !== null &&
    !defaultBranchOptions(selected.data.refs, selected.data.primaryRemoteName ?? null).some(
      (branch) => branch.name === props.value,
    );
  const items = ["", ...options.map((branch) => branch.name)];
  const label = props.mixed
    ? gt("Mixed", { $context: "projects have different values for a setting" })
    : props.value === null
      ? gt("Automatic", { $context: "default branch setting" })
      : unavailable
        ? gt("{branch} (unavailable)", { branch: props.value })
        : props.value;
  const select = (value: string) => {
    props.onChange(value || null);
    setOpen(false);
    setQuery("");
  };

  return (
    <BranchPicker
      items={items}
      filteredItems={items}
      value={props.mixed ? null : (props.value ?? "")}
      query={query}
      onQueryChange={setQuery}
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setQuery("");
      }}
      onSelectItem={select}
      hasNextPage={branches.data?.nextCursor != null}
      isFetchingNextPage={branches.isFetchingNextPage}
      onLoadNext={branches.loadNext}
      statusText={
        branches.error ??
        selected.error ??
        (branches.isPending && branches.data === null ? gt("Loading branches…") : null)
      }
      popupProps={{ align: "end", side: "bottom", className: "flex w-80 flex-col" }}
      renderItem={(name, index) => {
        const branch = options.find((option) => option.name === name);
        return branch ? (
          <BranchPickerRefItem
            branch={branch}
            projectCwd={props.cwd}
            index={index}
            onClick={() => select(name)}
          />
        ) : (
          <ComboboxItem value="" index={index} onClick={() => select("")}>
            <T context="default branch setting">Automatic</T>
          </ComboboxItem>
        );
      }}
    >
      <ComboboxTrigger
        aria-label={gt("Default branch")}
        className="w-full max-w-64"
        render={<Button variant="outline" size="sm" />}
      >
        <MiddleTruncate value={label} className="min-w-0 flex-1" />
        <ChevronDownIcon />
      </ComboboxTrigger>
    </BranchPicker>
  );
}
