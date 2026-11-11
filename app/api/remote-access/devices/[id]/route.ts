/** Revoke one paired device. Mac window only. */
import { remoteDeviceDelete } from "@/src/server";

export const dynamic = "force-dynamic";

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
	return remoteDeviceDelete(request, (await params).id);
}
