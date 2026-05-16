// Throwaway RSA-2048 test key pair. Generated once with:
//   openssl genrsa -traditional -out k.pem 2048
//   openssl pkcs8 -topk8 -nocrypt -in k.pem -out k.pkcs8.pem
//   openssl rsa -in k.pem -pubout -out k.pub
// Used ONLY by unit tests to verify JWT signing round-trips. Do not reuse
// for any real deployment.

export const TEST_PKCS1_PEM = `-----BEGIN RSA PRIVATE KEY-----
MIIEowIBAAKCAQEApQnA3zA0oTlVhwQLm47FZ+9vlRGyC5Vx3Px5Nn5aL9BSkTmI
eMCr0wlZoVaHDrCCOeBBenm+vA0FHVTvxyRyClonAneecwZPiig+1aOGbqhlUZxI
HhNaIL+sYZ7hhCuBE1Go0lqwWiAW/S7oBjgAVQt9wA4sEhmJEFc+MagmQzWy1g1I
q+yB/+ujkmWRWDqHqZkX5KHH/cIshB7XOXE2G8wuCEeB5lrTTEjkd6BIZRMkIlLH
8YSEWCRiYxCz8azpFV4oiwF+oTVXuMyZWxe5PXJjS8TWrXlQhXW1Il4Opj0PPH0y
xnmCDi/9JA0DC8VEpBCDiqXYZ2mecpbhSRUEwwIDAQABAoIBACf7wG/yCFYlA00G
FF/YC4heMEzPsDBxQNg2jJFAtE3QLSjE5QTIPPiQU9gsE+VhqvMlmwd2lliN2Pbd
vIelE0HhzICjBU69sSh6DpsIlomZn45RjAFJU/UKKtOtv9obBhbtmjZ4RTBYhOlK
42iaSa5Q7eLJLDEoYZYFZOp33+k5JXPMQ9r2T9viy9UUnpsIAPCFywjc7cPm2eRp
aURJFudObKDXBMQRb3jbA/sPPn4ibAloinJLHWpONV9LVu7m7BU/4aWsKlA+csT4
BNxUiDXiGs6w+Z0n6ylfFMs/36hhyv5zP89QfTSC+8iIR9KQE0nUC+QxtCZiqL0/
lj8cHjUCgYEA50bBRjmakCsUL8hNSfJofR28LrR35G1ya5HnhYyuzuoXXGpcBO23
iDZBSpfCQRaXIlfBraoKinbZgGk7lBrNxh9+c8tNCpoaYcX8twQKH+w0aKgA9VJB
4TW9FvNlRGcxDGDNJy3FnTQgyMvRphqjFTbCZQ6oI1j0wPBQMue2DpUCgYEAtq5I
XPneAPv4gHj2Ymj+ulDOm8TWqFpkkofUJh9LasZ2yPAt6DDVOAohe1oBv8sB1C5H
79Ie+NVTsPoJ6KtIwvFLnSa8mpaj20w6X8p7i0Ri+rMNvrR1k9erjiS04StxDPzh
xhyKD7U460wQ0tz/O2ZygZM9URb05kgSwXWTZ/cCgYAr9cX8/CwF5TpUDsWqHZqA
1asUUZdMYwVRrw0L1H7Rs6s3FLxi73BoQq/MZuY0iv+1NmsJAH46bXbQMrBxaVrd
otTdW7JMJpiHJyPvAaSPBs27aturxbPiA93qQ99mzhqDmM7F+KxMQkFNCXjTEtMW
0C7JGK0a8uiq18LWujZftQKBgEnMMCl3O0r0f1gPBaGNvtGvkTd2Fi1ejuBvBLH9
1G6nDBdyh2kUSR5hYVM+chRzwyJfK+pi3OYy76M/7z7R6wvthFlQ68IbdshBjBdk
afJBxyZ1rOjMZ+84ofJDO9r2vK29fsuUfeWIlRzg1q8IXgc2BK35uDyI5Jgep40F
nW3TAoGBAJJbZfsBvujmhzZcC4K8GiZr09+fTFA64mj3wZQqSvZ7UDGWEQxyDt9q
JQZR1KcDkcLQ9lttW/TvOhyxL7PuXRTqLeGJHIK6dZpq99FUjz5kNph8sZuHSFPX
3J2KO2KJWmF9cuuJ8yJHe4GB3MLwyBFQtjsIO+HY0reXESoHT9ri
-----END RSA PRIVATE KEY-----
`;

export const TEST_PKCS8_PEM = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQClCcDfMDShOVWH
BAubjsVn72+VEbILlXHc/Hk2flov0FKROYh4wKvTCVmhVocOsII54EF6eb68DQUd
VO/HJHIKWicCd55zBk+KKD7Vo4ZuqGVRnEgeE1ogv6xhnuGEK4ETUajSWrBaIBb9
LugGOABVC33ADiwSGYkQVz4xqCZDNbLWDUir7IH/66OSZZFYOoepmRfkocf9wiyE
Htc5cTYbzC4IR4HmWtNMSOR3oEhlEyQiUsfxhIRYJGJjELPxrOkVXiiLAX6hNVe4
zJlbF7k9cmNLxNateVCFdbUiXg6mPQ88fTLGeYIOL/0kDQMLxUSkEIOKpdhnaZ5y
luFJFQTDAgMBAAECggEAJ/vAb/IIViUDTQYUX9gLiF4wTM+wMHFA2DaMkUC0TdAt
KMTlBMg8+JBT2CwT5WGq8yWbB3aWWI3Y9t28h6UTQeHMgKMFTr2xKHoOmwiWiZmf
jlGMAUlT9Qoq062/2hsGFu2aNnhFMFiE6UrjaJpJrlDt4sksMShhlgVk6nff6Tkl
c8xD2vZP2+LL1RSemwgA8IXLCNztw+bZ5GlpREkW505soNcExBFveNsD+w8+fiJs
CWiKcksdak41X0tW7ubsFT/hpawqUD5yxPgE3FSINeIazrD5nSfrKV8Uyz/fqGHK
/nM/z1B9NIL7yIhH0pATSdQL5DG0JmKovT+WPxweNQKBgQDnRsFGOZqQKxQvyE1J
8mh9HbwutHfkbXJrkeeFjK7O6hdcalwE7beINkFKl8JBFpciV8GtqgqKdtmAaTuU
Gs3GH35zy00Kmhphxfy3BAof7DRoqAD1UkHhNb0W82VEZzEMYM0nLcWdNCDIy9Gm
GqMVNsJlDqgjWPTA8FAy57YOlQKBgQC2rkhc+d4A+/iAePZiaP66UM6bxNaoWmSS
h9QmH0tqxnbI8C3oMNU4CiF7WgG/ywHULkfv0h741VOw+gnoq0jC8UudJryalqPb
TDpfynuLRGL6sw2+tHWT16uOJLThK3EM/OHGHIoPtTjrTBDS3P87ZnKBkz1RFvTm
SBLBdZNn9wKBgCv1xfz8LAXlOlQOxaodmoDVqxRRl0xjBVGvDQvUftGzqzcUvGLv
cGhCr8xm5jSK/7U2awkAfjptdtAysHFpWt2i1N1bskwmmIcnI+8BpI8Gzbtq26vF
s+ID3epD32bOGoOYzsX4rExCQU0JeNMS0xbQLskYrRry6KrXwta6Nl+1AoGAScww
KXc7SvR/WA8FoY2+0a+RN3YWLV6O4G8Esf3UbqcMF3KHaRRJHmFhUz5yFHPDIl8r
6mLc5jLvoz/vPtHrC+2EWVDrwht2yEGMF2Rp8kHHJnWs6Mxn7zih8kM72va8rb1+
y5R95YiVHODWrwheBzYErfm4PIjkmB6njQWdbdMCgYEAkltl+wG+6OaHNlwLgrwa
JmvT359MUDriaPfBlCpK9ntQMZYRDHIO32olBlHUpwORwtD2W21b9O86HLEvs+5d
FOot4Ykcgrp1mmr30VSPPmQ2mHyxm4dIU9fcnYo7YolaYX1y64nzIkd7gYHcwvDI
EVC2Owg74djSt5cRKgdP2uI=
-----END PRIVATE KEY-----
`;

export const TEST_PUBLIC_PEM = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEApQnA3zA0oTlVhwQLm47F
Z+9vlRGyC5Vx3Px5Nn5aL9BSkTmIeMCr0wlZoVaHDrCCOeBBenm+vA0FHVTvxyRy
ClonAneecwZPiig+1aOGbqhlUZxIHhNaIL+sYZ7hhCuBE1Go0lqwWiAW/S7oBjgA
VQt9wA4sEhmJEFc+MagmQzWy1g1Iq+yB/+ujkmWRWDqHqZkX5KHH/cIshB7XOXE2
G8wuCEeB5lrTTEjkd6BIZRMkIlLH8YSEWCRiYxCz8azpFV4oiwF+oTVXuMyZWxe5
PXJjS8TWrXlQhXW1Il4Opj0PPH0yxnmCDi/9JA0DC8VEpBCDiqXYZ2mecpbhSRUE
wwIDAQAB
-----END PUBLIC KEY-----
`;

export async function importTestPublicKey(): Promise<CryptoKey> {
  const der = pemBodyToBytes(TEST_PUBLIC_PEM);
  return crypto.subtle.importKey(
    "spki",
    der,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
}

function pemBodyToBytes(pem: string): Uint8Array {
  const body = pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const bin = atob(body);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

interface IssueCommentOpts {
  action?: "created" | "edited" | "deleted";
  body?: string;
  authorAssoc?: string;
  authorLogin?: string;
  authorType?: "User" | "Bot";
  prAuthorLogin?: string;
  prState?: "open" | "closed";
  isPullRequest?: boolean;
  consumerRepo?: string;
  installationId?: number;
}

// Mirrors the real GitHub `issue_comment:created` webhook shape — note there is
// no top-level `pull_request` object. Head SHA + base ref must be fetched via
// REST /repos/{owner}/{repo}/pulls/{number} by the handler.
export function issueCommentPayload(opts: IssueCommentOpts = {}) {
  const consumerRepo = opts.consumerRepo ?? "octo-org/example";
  return {
    action: opts.action ?? "created",
    issue: {
      number: 42,
      state: opts.prState ?? "open",
      pull_request: opts.isPullRequest === false
        ? undefined
        : { url: `https://api.github.com/repos/${consumerRepo}/pulls/42` },
      user: { login: opts.prAuthorLogin ?? "ellotheth" },
    },
    comment: {
      id: 12345,
      body: opts.body ?? "/wrily review",
      author_association: opts.authorAssoc ?? "OWNER",
      user: { login: opts.authorLogin ?? "ellotheth", type: opts.authorType ?? "User" },
    },
    repository: { full_name: consumerRepo },
    installation: { id: opts.installationId ?? 99887766 },
    sender: { login: opts.authorLogin ?? "ellotheth" },
  };
}

// PR object the handler fetches via `GET /repos/{owner}/{repo}/pulls/{number}`.
// Tests stub the response of that REST call with this shape.
export function pullRequestApiResponse(opts: { headSha?: string; baseRef?: string; prAuthor?: string } = {}) {
  return {
    number: 42,
    state: "open",
    head: { sha: opts.headSha ?? "abc123" },
    base: { ref: opts.baseRef ?? "main" },
    user: { login: opts.prAuthor ?? "ellotheth" },
  };
}
