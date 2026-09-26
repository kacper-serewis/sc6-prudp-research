/**
 * NATTraversalProtocol (port of `nat_traversal.rs`): relays probe requests to the targeted clients,
 * so they send NAT punch-through probes to each other.
 */
import { randomU32 } from "../quazal/client-info";
import { encode } from "../quazal/codec";
import { PacketType, QPacket, StreamType } from "../quazal/prudp/packet";
import { InitiateProbeRequest, NATTraversalProtocol } from "../protocols/nat-traversal/nat-traversal-protocol";
import { encodeRmcRequest } from "../quazal/rmc/message";
import { implementProtocol, loginRequired } from "../quazal/rmc/protocol";

export function natTraversalProtocol() {
  return implementProtocol(NATTraversalProtocol, {
    requestProbeInitiationExt(request, call) {
      loginRequired(call);
      call.logger.info("Probe initiation requested", {
        targets: request.urlTargetList.map(String),
        probe: request.urlStationToProbe.toString(),
      });

      for (const url of request.urlTargetList) {
        const rvcid = url.params.get("RVCID");
        if (rvcid === undefined) {
          call.logger.warn(`${url} doesn't include RVCID`);
          continue;
        }
        if (!/^\+?\d+$/.test(rvcid) || Number(rvcid) > 0xffff_ffff) {
          call.logger.warn(`${url} doesn't include valid RVCID`);
          continue;
        }
        const target = call.server.clientByConnectionId(Number(rvcid));
        if (!target) {
          call.logger.warn(`No client found for RVCID ${rvcid}`);
          continue;
        }

        const payload = encodeRmcRequest({
          protocolId: NATTraversalProtocol.id,
          callId: randomU32(),
          methodId: NATTraversalProtocol.methods.initiateProbe.id,
          parameters: encode(InitiateProbeRequest, { urlStationToProbe: request.urlStationToProbe }),
        });
        call.logger.info(`Sending probe to ${url} (${target.address.host}:${target.address.port})`);
        call.server.sendRequest(
          call.logger,
          target,
          new QPacket({
            source: { port: 1, streamType: StreamType.RVSec },
            destination: { port: 15, streamType: StreamType.RVSec },
            packetType: PacketType.Data,
            payload,
          }),
        );
      }
      return {};
    },
  });
}
