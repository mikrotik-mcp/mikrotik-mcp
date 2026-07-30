/**
 * `/log print detail` fixtures for the attack parser.
 *
 * Reproductions of output taken from a REAL RouterOS 7 device that was under an
 * active brute-force attack while this module was written. Every address has
 * been rewritten into the documentation ranges (RFC 5737) or RFC 1918 — what is
 * preserved is the SHAPE that broke the shared parser, never anyone's network
 * or the addresses that attacked it.
 *
 * TypeScript strings rather than files, for the same reason as
 * `tests/sim/fixtures/configs.ts`: the test runner's tsconfig has no Node types.
 */

/**
 * The exact wire shape, including the two traps: `time=` carries an UNQUOTED
 * space, and records are separated by blank lines with no `.id=` to split on.
 * Note the trailing space RouterOS leaves inside the `extra-info` quotes.
 */
export const SSH_BRUTE_FORCE = ` time=2026-07-30 17:23:00 topics=system,error,critical 
   message="login failure for user username from 203.0.113.7 via ssh" 
   extra-info="app=ssh duser=username outcome=failure src=203.0.113.7 " 

 time=2026-07-30 17:23:31 topics=system,error,critical 
   message="login failure for user sshd from 203.0.113.7 via ssh" 
   extra-info="app=ssh duser=sshd outcome=failure src=203.0.113.7 " 

 time=2026-07-30 17:24:57 topics=system,error,critical 
   message="login failure for user oracle from 203.0.113.7 via ssh" 
   extra-info="app=ssh duser=oracle outcome=failure src=203.0.113.7 " 
`;

/** The API service hammered roughly once a second — the real observed pattern. */
export const API_BRUTE_FORCE = ` time=2026-07-30 17:17:45 topics=system,error,critical 
   message="login failure for user admin from 198.51.100.22 via api" 
   extra-info="app=api duser=admin outcome=failure src=198.51.100.22 " 

 time=2026-07-30 17:17:46 topics=system,error,critical 
   message="login failure for user admin from 198.51.100.22 via api" 
   extra-info="app=api duser=admin outcome=failure src=198.51.100.22 " 

 time=2026-07-30 17:17:48 topics=system,error,critical 
   message="login failure for user admin from 198.51.100.22 via api" 
   extra-info="app=api duser=admin outcome=failure src=198.51.100.22 " 
`;

/**
 * Successful logins.
 *
 * The 10.64.60.2 line is the one that matters: on the real device that address
 * is the MCP server's own management session, and it logs in every few seconds.
 * A detector that treats "successful login" as interesting alerts on US, forever
 * — which is exactly the false positive `docs/tasks/11` §4 was written around.
 */
export const SUCCESSFUL_LOGINS = ` time=2026-07-30 17:15:43 topics=system,info,account 
   message="user admin logged in from 10.64.60.2 via ssh" 
   extra-info="app=ssh duser=admin outcome=success src=10.64.60.2 " 

 time=2026-07-30 17:13:00 topics=system,info,account 
   message="user admin logged in from 192.0.2.55 via ssh" 
   extra-info="app=ssh duser=admin outcome=success src=192.0.2.55 " 

 time=2026-07-30 17:16:01 topics=system,info,account 
   message="user admin logged out from 10.64.60.2 via ssh" 
   extra-info="app=ssh duser=admin outcome=success src=10.64.60.2 " 
`;

/** RouterOS 6: no `extra-info` at all, so the prose fallback is the only route. */
export const ROUTEROS_6 = ` time=jul/30/2026 17:23:00 topics=system,error,critical 
   message="login failure for user admin from 203.0.113.7 via winbox" 

 time=jul/30/2026 17:23:04 topics=system,info,account 
   message="user admin logged in from 192.0.2.55 via telnet" 
`;

/** A firewall drop with a log prefix, plus a line with no address at all. */
export const FIREWALL_AND_NOISE = ` time=2026-07-30 18:00:00 topics=firewall,info 
   message="input: in:ether1 out:(unknown 0), proto TCP (SYN), 203.0.113.90:51222->192.0.2.1:8291, len 60" 
   extra-info="" 

 time=2026-07-30 18:00:05 topics=system,info 
   message="ipsec,debug rekeying" 

 time=2026-07-30 18:00:09 topics=script,info 
   message="script had a comment with an = sign: k=v inside prose" 
`;

/** A record whose message is missing entirely — must be reported, never dropped. */
export const MALFORMED = ` time=2026-07-30 19:00:00 topics=system,info 
   extra-info="app=ssh outcome=failure" 

 time=2026-07-30 19:00:01 topics=system,info 
   message="login failure for user ok from 203.0.113.7 via ssh" 
`;

/** An IPv6 source, which the address fallback must also recognise. */
export const IPV6_SOURCE = ` time=2026-07-30 20:00:00 topics=system,error,critical 
   message="login failure for user admin from 2001:db8::dead via ssh" 
   extra-info="app=ssh duser=admin outcome=failure src=2001:db8::dead " 
`;
