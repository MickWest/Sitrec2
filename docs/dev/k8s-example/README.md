# Sitrec on Kubernetes — example manifests

Ready-to-use manifests for running Sitrec on Kubernetes. They accompany the
[Running on Kubernetes](../Installing-and-configuring.md#running-on-kubernetes-advanced)
section of the install guide — read that for the full explanation; this folder is the
copy-paste version.

These were validated end-to-end against a local [`kind`](https://kind.sigs.k8s.io/)
cluster (Kubernetes v1.36) using the published `ghcr.io/mickwest/sitrec2:latest` image:
Secret-based credential injection, Service routing, the non-root `securityContext`, and the
health probes were all confirmed working.

## Files

| File | What it is |
|------|------------|
| `sitrec-deployment.yaml` | Deployment + Service. Runs Sitrec, injects S3 creds from a Secret, runs non-root, with health probes and resource limits. |
| `sitrec-ingress.yaml` | Optional Ingress to expose Sitrec outside the cluster (needs an ingress controller). |

## Quick start

```bash
# 1. Create the Secret with your real S3 credentials (Method A — keys named as Sitrec expects)
kubectl create secret generic sitrec-s3 \
  --from-literal=S3_ACCESS_KEY_ID=AKIA... \
  --from-literal=S3_SECRET_ACCESS_KEY=...

# 2. Edit sitrec-deployment.yaml: set S3_BUCKET / S3_REGION (and the image, if you baked one)

# 3. Apply
kubectl apply -f sitrec-deployment.yaml
kubectl rollout status deploy/sitrec

# 4. Test (see the install guide's "Step 4" for the full checks)
kubectl exec deploy/sitrec -- cat /var/www/html/shared.env.php          # creds present?
kubectl exec deploy/sitrec -- curl -sf http://localhost:8080/ >/dev/null && echo OK
kubectl port-forward deploy/sitrec 8080:8080                            # then open http://localhost:8080

# 5. (Optional) expose it
kubectl apply -f sitrec-ingress.yaml
```

Add `-n your-namespace` to every command if you're not using `default`. All referenced
objects (Secret, imagePullSecret, ConfigMap, PVCs) must share the Deployment's namespace.

## Method B — a Secret whose keys are named differently

If you already have an S3 Secret with its own key names (e.g. `aws-creds` with
`aws_access_key_id` / `aws_secret_access_key`), don't rename it — map each key to the
variable Sitrec expects. Replace the `envFrom:` block in `sitrec-deployment.yaml` with:

```yaml
          env:
            - { name: SAVE_TO_S3, value: "true" }
            - { name: S3_BUCKET,  value: "your-bucket" }
            - { name: S3_REGION,  value: "us-west-2" }
            - name: S3_ACCESS_KEY_ID
              valueFrom:
                secretKeyRef: { name: aws-creds, key: aws_access_key_id }
            - name: S3_SECRET_ACCESS_KEY
              valueFrom:
                secretKeyRef: { name: aws-creds, key: aws_secret_access_key }
```

## Private (baked) image

If you push a [baked image](../Installing-and-configuring.md#baking-a-pre-configured-image-advanced)
to a private registry, the cluster needs pull credentials, or the pod fails with
`ImagePullBackOff`:

```bash
kubectl create secret docker-registry regcred \
  --docker-server=registry.example.com \
  --docker-username=<user> --docker-password=<token>
```

Then uncomment the `imagePullSecrets:` block in `sitrec-deployment.yaml` and point `image:`
at your baked tag.

## Notes

- **Don't scale past `replicas: 1`** unless `SAVE_TO_S3=true` and you use no local-filesystem
  storage — user uploads and the tile cache are written inside each pod and aren't shared.
- **Probes hit `/`, not `/sitrecServer/info.php`.** `info.php` is admin-only and returns 403
  to the kubelet (which probes from the node, not localhost), so probing it leaves the pod
  permanently *NotReady*. The web root `/` returns 200 to anyone.
- **Kubernetes Secrets are base64-encoded, not encrypted.** Restrict `get`/`list` on secrets
  via RBAC and enable etcd encryption-at-rest for production.
