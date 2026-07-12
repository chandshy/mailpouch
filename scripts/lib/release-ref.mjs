export function expectedReleaseTag(version) {
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`Invalid package version: ${String(version)}`);
  }
  return `v${version}`;
}

export function validateReleaseRef({ tag, version, headSha, tagSha }) {
  const expected = expectedReleaseTag(version);
  if (tag !== expected) {
    throw new Error(`Release tag ${String(tag)} does not match package version ${expected}`);
  }
  if (!/^[0-9a-f]{40}$/i.test(headSha) || !/^[0-9a-f]{40}$/i.test(tagSha)) {
    throw new Error("Release HEAD and tag target must be full Git commit SHAs");
  }
  if (headSha.toLowerCase() !== tagSha.toLowerCase()) {
    throw new Error(`Release tag ${tag} does not point at the checked-out commit`);
  }
  return expected;
}
