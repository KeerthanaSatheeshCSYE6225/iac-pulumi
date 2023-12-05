# iac-pulumi

## Getting Started

To get started with the pulumi project, follow these instructions.

### Prerequisites

Before you begin, ensure you have met the following requirements:

- Prerequisite 1: Configure the aws cli profile
- Prerequisite 2: Configure the pulumi stack

### Installation

1. Clone this repository:

   ```bash
   git clone git@github.com:Keerthana734/iac-pulumi.git
   ```

2. Pulumi Commands
   pulumi config set pulumicloud:amiInstance ABC(replace ABC)
   pulumi refresh
   pulumi stack rm dev
   pulumi config set aws:region us-west-1
   pulumi up
   pulumicloud:vpcCidrBlock: "10.0.0.0/16"

###   import certificate
aws acm import-certificate \
  --certificate fileb://path/to/demo_keerthanadevhub_me.crt \
  --certificate-chain fileb://path/to/demo_keerthanadevhub_me.ca-bundle \
  --private-key fileb://path/to/mydemodomain.key
