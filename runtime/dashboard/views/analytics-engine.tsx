import { useState } from "preact/hooks";
import { formatTime } from "../lib";
import { useQuery, useMutation } from "../rpc/hooks";
import { EmptyState, Table, PageHeader, DeleteButton, ServiceInfo, RefreshButton } from "../components";
import type { AnalyticsEngineDataPoint } from "../rpc/types";

export function AnalyticsEngineView({ route }: { route: string }) {
	const parts = route.split("/").filter(Boolean);
	if (parts.length >= 2) return <DataPointDetail id={parts[1]!} />;
	return <DataPointList />;
}

function DataPointList() {
	const [datasetFilter, setDatasetFilter] = useState("");
	const { data: points, refetch } = useQuery("analyticsEngine.list", {
		dataset: datasetFilter || undefined,
	});
	const { data: stats } = useQuery("analyticsEngine.stats");
	const { data: datasets } = useQuery("analyticsEngine.datasets");
	const { data: configGroups } = useQuery("config.forService", { type: "analytics_engine" });
	const deletePoint = useMutation("analyticsEngine.delete");

	const handleDelete = async (id: string) => {
		if (!confirm("Delete this data point?")) return;
		await deletePoint.mutate({ id });
		refetch();
	};

	return (
		<div class="p-8 max-w-6xl">
			<PageHeader title="Analytics Engine" subtitle={`${stats?.total ?? 0} data point(s)`} actions={<RefreshButton onClick={refetch} />} />
			<div class="flex gap-6 items-start">
				<div class="flex-1 min-w-0">
					<div class="mb-6 flex gap-2 items-center flex-wrap">
						{(datasets?.length ?? 0) > 0 && (
							<select
								value={datasetFilter}
								onChange={e => setDatasetFilter((e.target as HTMLSelectElement).value)}
								class="text-xs bg-panel-secondary border border-border rounded-md px-2 py-1 outline-none"
							>
								<option value="">All datasets</option>
								{datasets!.map(d => (
									<option key={d} value={d}>{d}</option>
								))}
							</select>
						)}
					</div>
					{!points?.length ? (
						<EmptyState message="No data points found" />
					) : (
						<Table
							headers={["Dataset", "Index", "Doubles", "Blobs", "Time", ""]}
							rows={points.map(p => [
								<a href={`#/analytics/${p.id}`} class="font-mono text-xs text-blue-600 hover:underline">{p.dataset}</a>,
								<span class="font-mono text-xs text-text-muted">{p.index1 ?? "-"}</span>,
								<span class="text-xs text-text-muted tabular-nums">{formatDoubles(p)}</span>,
								<span class="text-xs text-text-muted truncate max-w-[150px] block">{formatBlobs(p)}</span>,
								<span class="text-xs text-text-muted">{formatTime(p.timestamp)}</span>,
								<DeleteButton onClick={() => handleDelete(p.id)} />,
							])}
						/>
					)}
				</div>
				<ServiceInfo
					description="Analytics Engine — write-only data point storage for custom metrics, events, and clickstream data."
					stats={[
						{ label: "Total", value: stats?.total ?? 0 },
						...(stats?.byDataset ? Object.entries(stats.byDataset).map(([k, v]) => ({ label: k, value: v })) : []),
					]}
					configGroups={configGroups}
					links={[
						{ label: "Analytics Engine docs", href: "https://developers.cloudflare.com/analytics/analytics-engine/" },
						{ label: "SQL API", href: "https://developers.cloudflare.com/analytics/analytics-engine/sql-api/" },
					]}
				/>
			</div>
		</div>
	);
}

function DataPointDetail({ id }: { id: string }) {
	const { data } = useQuery("analyticsEngine.get", { id });

	if (!data) {
		return (
			<div class="p-8">
				<a href="#/analytics" class="text-sm text-blue-600 hover:underline mb-4 inline-block">Back to data points</a>
				<EmptyState message="Data point not found" />
			</div>
		);
	}

	const doubles: { name: string; value: number }[] = [];
	const blobs: { name: string; value: string | null }[] = [];
	const row = data as unknown as Record<string, unknown>;
	for (let i = 1; i <= 20; i++) {
		const dv = row[`double${i}`] as number | null;
		if (dv != null) doubles.push({ name: `double${i}`, value: dv });
		const bv = row[`blob${i}`] as string | null;
		if (bv != null) blobs.push({ name: `blob${i}`, value: bv });
	}

	return (
		<div class="p-8 max-w-4xl">
			<a href="#/analytics" class="text-sm text-blue-600 hover:underline mb-4 inline-block">Back to data points</a>
			<div class="bg-panel border border-border rounded-lg p-6">
				<h2 class="text-lg font-semibold text-ink mb-4">Data Point Detail</h2>
				<div class="grid grid-cols-2 gap-4 mb-4 text-sm">
					<div>
						<span class="text-text-muted">Dataset:</span>{" "}
						<span class="font-mono">{data.dataset}</span>
					</div>
					<div>
						<span class="text-text-muted">Time:</span>{" "}
						{formatTime(data.timestamp)}
					</div>
					<div>
						<span class="text-text-muted">Index:</span>{" "}
						<span class="font-mono">{data.index1 ?? "-"}</span>
					</div>
					<div>
						<span class="text-text-muted">Sample interval:</span>{" "}
						<span class="tabular-nums">{data._sample_interval}</span>
					</div>
				</div>
				{doubles.length > 0 && (
					<div class="mb-4">
						<div class="text-xs text-text-muted mb-2">Doubles</div>
						<div class="bg-panel-secondary border border-border rounded-lg p-4">
							<div class="grid grid-cols-4 gap-2 text-sm">
								{doubles.map(d => (
									<div key={d.name}>
										<span class="text-text-muted text-xs">{d.name}:</span>{" "}
										<span class="font-mono tabular-nums">{d.value}</span>
									</div>
								))}
							</div>
						</div>
					</div>
				)}
				{blobs.length > 0 && (
					<div>
						<div class="text-xs text-text-muted mb-2">Blobs</div>
						<div class="bg-panel-secondary border border-border rounded-lg p-4">
							<div class="space-y-1 text-sm">
								{blobs.map(b => (
									<div key={b.name}>
										<span class="text-text-muted text-xs">{b.name}:</span>{" "}
										<span class="font-mono">{b.value}</span>
									</div>
								))}
							</div>
						</div>
					</div>
				)}
			</div>
		</div>
	);
}

function formatDoubles(p: AnalyticsEngineDataPoint): string {
	const vals = [p.double1, p.double2, p.double3, p.double4, p.double5].filter((v): v is number => v != null);
	return vals.length ? vals.join(", ") : "-";
}

function formatBlobs(p: AnalyticsEngineDataPoint): string {
	const vals = [p.blob1, p.blob2, p.blob3, p.blob4, p.blob5].filter((v): v is string => v != null);
	return vals.length ? vals.join(", ") : "-";
}
