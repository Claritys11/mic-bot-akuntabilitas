import type { OutgoingMessage, Platform, Sender } from '../core/types.ts';

/**
 * Scheduler menghasilkan OutgoingMessage tanpa tahu platformnya. DM membawa `member.platform`;
 * channel dikenali dari bentuk ID-nya: JID WhatsApp selalu berisi '@' (…@g.us, …@lid),
 * ID Discord berupa angka (snowflake).
 */
export function platformOf(msg: OutgoingMessage): Platform {
  if (msg.to.kind === 'dm') return msg.to.member.platform;
  return msg.to.channelId.includes('@') ? 'whatsapp' : 'discord';
}

export function routeSender(senders: Partial<Record<Platform, Sender>>): Sender {
  return {
    async send(msg) {
      const p = platformOf(msg);
      const s = senders[p];
      if (!s) throw new Error(`Adapter ${p} tidak aktif — pesan tidak terkirim`);
      await s.send(msg);
    },
  };
}
