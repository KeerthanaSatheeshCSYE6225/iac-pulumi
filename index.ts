import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import * as gcp from "@pulumi/gcp";
import * as route53 from "@pulumi/aws/route53";
import { Tag } from "@pulumi/aws/ec2";

require("dotenv").config();

// Load configurations
const config = new pulumi.Config("pulumicloud");
const awsConfig = new pulumi.Config("aws");
const domain_name = "keerthanadevhub.me";
// Create an AWS SNS topic
const snsTopic = new aws.sns.Topic("mySnsTopic", {
  displayName: "My SNS Topic",
});

// Get the AWS profile from the config
const awsProfile = awsConfig.require("profile");

// Get AWS region from configuration
const region = awsConfig.require("region") as aws.Region;

// Get other configurations
const vpcCidrBlock = config.require("vpcCidrBlock");

const amiInstance = config.require("amiInstance");

const dbName = config.require("dbName");
const dbPassword = config.require("dbPassword");
const rdsUser = config.require("rdsUser");
const rdsIdentifier = config.require("rdsIdentifier");

const keyPem = config.require("keyPem");
// Load Route 53 configuration

const domainName = config.require("domainName");
const hostedZoneId = config.require("hostedZoneId");
// const appPort = config.requireNumber("appPort");
const appPort = 8080;

// Configure AWS provider with the specified region
const provider = new aws.Provider("provider", {
  region: region,
  profile: awsProfile,
});

// Create a VPC
const vpc = new aws.ec2.Vpc(
  "pulumiVPC",
  {
    cidrBlock: vpcCidrBlock,
    tags: {
      Name: "pulumiVPC",
    },
  },
  { provider }
);

// Query the number of availability zones in the specified region
const azs = pulumi.output(aws.getAvailabilityZones());

// Create subnets dynamically based on the number of availability zones (up to 3)
const subnets = azs.apply((azs) =>
  azs.names.slice(0, 3).flatMap((az, index) => {
    const publicSubnet = new aws.ec2.Subnet(
      `publicSubnet-${index}`,
      {
        vpcId: vpc.id,
        cidrBlock: `${vpcCidrBlock.split(".")[0]}.${
          vpcCidrBlock.split(".")[1]
        }.${index * 2}.0/24`,
        availabilityZone: az,
        mapPublicIpOnLaunch: true,
        tags: {
          Name: `PublicSubnet-${index}`,
        },
      },
      { provider }
    );

    const privateSubnet = new aws.ec2.Subnet(
      `privateSubnet-${index}`,
      {
        vpcId: vpc.id,
        cidrBlock: `${vpcCidrBlock.split(".")[0]}.${
          vpcCidrBlock.split(".")[1]
        }.${index * 2 + 1}.0/24`,
        availabilityZone: az,
        mapPublicIpOnLaunch: false,
        tags: {
          Name: `PrivateSubnet-${index}`,
        },
      },
      { provider }
    );

    return [publicSubnet, privateSubnet];
  })
);

// Create an Internet Gateway and attach it to the VPC
const internetGateway = new aws.ec2.InternetGateway(
  "internetGateway",
  {
    vpcId: vpc.id,
    tags: {
      Name: "InternetGatewayPulumi",
    },
  },
  { provider }
);

// Create a Public Route Table with a route to the Internet Gateway
const publicRouteTable = new aws.ec2.RouteTable(
  "publicRouteTable",
  {
    vpcId: vpc.id,
    tags: {
      Name: "PublicRouteTablePulumi",
    },
    routes: [
      {
        cidrBlock: "0.0.0.0/0",
        gatewayId: internetGateway.id,
      },
    ],
  },
  { provider }
);

// Associate each public subnet with the Public Route Table
subnets.apply((subnetArray) =>
  subnetArray
    .filter((_, index) => index % 2 === 0)
    .forEach((subnet) =>
      subnet.id.apply(
        (id) =>
          new aws.ec2.RouteTableAssociation(
            `publicRtAssoc-${id}`,
            {
              subnetId: id,
              routeTableId: publicRouteTable.id,
            },
            { provider }
          )
      )
    )
);

// Create a Private Route Table
const privateRouteTable = new aws.ec2.RouteTable(
  "privateRouteTable",
  {
    vpcId: vpc.id,
    tags: {
      Name: "PrivateRouteTablePulumi",
    },
  },
  { provider }
);

// Associate each private subnet with the Private Route Table
subnets.apply((subnetArray) =>
  subnetArray
    .filter((_, index) => index % 2 !== 0)
    .forEach((subnet) =>
      subnet.id.apply(
        (id) =>
          new aws.ec2.RouteTableAssociation(
            `privateRtAssociation-${id}`,
            {
              subnetId: id,
              routeTableId: privateRouteTable.id,
            },
            { provider }
          )
      )
    )
);
// Create Load Balancer Security Group
const loadBalancerSecurityGroup = new aws.ec2.SecurityGroup(
  "loadBalancerSecurityGroup",
  {
    name: "loadBalancerSecurityGroup",
    description:
      "Security group for the load balancer to access the web application",
    vpcId: vpc.id,
    ingress: [
      {
        fromPort: 80,
        toPort: 80,
        protocol: "tcp",
        cidrBlocks: ["0.0.0.0/0"],
      },
      {
        fromPort: 443,
        toPort: 443,
        protocol: "tcp",
        cidrBlocks: ["0.0.0.0/0"],
      },
    ],
    egress: [
      {
        protocol: "all",
        fromPort: 0,
        toPort: 0,
        cidrBlocks: ["0.0.0.0/0"],
      },
    ],
  },
  { provider }
);

// Update App Security Group to allow access from Load Balancer Security Group
const applicationSecurityGroup = new aws.ec2.SecurityGroup(
  "applicationSecurityGroup",
  {
    name: "applicationSecurityGroup",
    description: "Security group for EC2 instances hosting web applications",
    vpcId: vpc.id,
    ingress: [
      {
        fromPort: 22,
        toPort: 22,
        protocol: "tcp",
        cidrBlocks: ["0.0.0.0/0"], // Allow access from Load Balancer SG
      },
      {
        fromPort: appPort,
        toPort: appPort,
        protocol: "tcp",
        securityGroups: [loadBalancerSecurityGroup.id], // Allow access from Load Balancer SG
      },
    ],
    egress: [
      {
        protocol: "all",
        fromPort: 0,
        toPort: 0,
        cidrBlocks: ["0.0.0.0/0"],
      },
    ],
  },
  { provider }
);
const firstPublicSubnet = subnets[0].id;
export const publicSubnetIds = subnets.apply((subnets) =>
  subnets.filter((_, index) => index % 2 === 0).map((subnet) => subnet.id)
);
// Create an EC2 instance

// Create DB Security Group
const dbSecurityGroup = new aws.ec2.SecurityGroup("database-security-group", {
  description: "Security group for RDS instances",
  vpcId: vpc.id,
  ingress: [
    {
      protocol: "tcp",
      fromPort: 3306, // for MySQL/MariaDB, use 5432 for PostgreSQL
      toPort: 3306,
      securityGroups: [applicationSecurityGroup.id],
    },
  ],
  egress: [
    {
      protocol: "all",
      fromPort: 0,
      toPort: 0,
      cidrBlocks: ["0.0.0.0/0"],
    },
  ],
});

export const privateSubnetIds = subnets.apply((subnets) =>
  subnets.filter((_, index) => index % 2 !== 0).map((subnet) => subnet.id)
);

const dbSubnets = new aws.rds.SubnetGroup("dbsubnets", {
  subnetIds: privateSubnetIds,
});
// RDS Parameter Group
const rdsParameterGroup = new aws.rds.ParameterGroup("rds-parameter-group", {
  family: "mysql8.0", // Change this to your specific DB engine and version
  parameters: [
    {
      name: "max_user_connections",
      value: "100", // Change this to your desired value
    },
  ],
});

// RDS Instance
const rdsInstance = new aws.rds.Instance("csye6225-rds-instance", {
  engine: "mysql",
  //engineVersion: "8.0.33",
  instanceClass: "db.t2.micro", // Change this to the desired instance type
  allocatedStorage: 20, // Set the storage as needed
  dbSubnetGroupName: dbSubnets.id, // Use your private subnet group name
  multiAz: false,
  parameterGroupName: rdsParameterGroup.name,
  skipFinalSnapshot: true,
  publiclyAccessible: false,
  username: rdsUser,
  password: dbPassword,
  dbName: dbName,
  vpcSecurityGroupIds: [dbSecurityGroup.id],
  identifier: rdsIdentifier,
});

const ec2Role = new aws.iam.Role("ec2Role", {
  assumeRolePolicy: JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      {
        Action: "sts:AssumeRole",
        Effect: "Allow",
        Principal: {
          Service: "ec2.amazonaws.com",
        },
      },
    ],
  }),
});

const cloudWatchAgentServerPolicy = aws.iam.getPolicy({
  arn: "arn:aws:iam::aws:policy/CloudwatchAgentServerPolicy",
});

const policyAttachment = cloudWatchAgentServerPolicy.then((policy) => {
  return new aws.iam.PolicyAttachment("cloudWatchAgentServerPolicyAttachment", {
    policyArn: policy.arn,
    roles: [ec2Role.name],
  });
});

const ec2InstanceProfile = new aws.iam.InstanceProfile("ec2InstanceProfile", {
  name: "ec2InstanceProfile",
  role: ec2Role.name,
});

const ec2Instance = new aws.ec2.Instance(
  "ec2Instance",
  {
    ami: amiInstance,
    instanceType: "t2.micro",
    keyName: keyPem,
    vpcSecurityGroupIds: [applicationSecurityGroup.id],
    subnetId: firstPublicSubnet,
    rootBlockDevice: {
      volumeSize: 25,
      volumeType: "gp2",
      deleteOnTermination: true,
    },
    iamInstanceProfile: ec2InstanceProfile.id,
    userData: pulumi.interpolate`#!/bin/bash
                sudo sh -c 'echo "HOST=${rdsInstance.address}" >> /opt/csye6225/webapp/.env'
                sudo sh -c 'echo "USER=${rdsInstance.username}" >> /opt/csye6225/webapp/.env'
                sudo sh -c 'echo "PASSWORD=${rdsInstance.password}" >> /opt/csye6225/webapp/.env'
                sudo sh -c 'echo "DB=${rdsInstance.dbName}" >> /opt/csye6225/webapp/.env'
                sudo systemctl daemon-reload
                sudo systemctl enable webapp
                sudo systemctl start webapp
                sudo /opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl \
                  -a fetch-config \
                  -m ec2 \
                  -c file:/opt/aws/amazon-cloudwatch-agent/etc/cloudwatch-config.json \
                  -s
                  sudo systemctl enable amazon-cloudwatch-agent
                  sudo systemctl start amazon-cloudwatch-agent
                  sudo systemctl daemon-reload`,
  },
  { provider }
);

const eip = new aws.ec2.Eip("myEip", {
  instance: ec2Instance.id.apply((id) => id),
});

const eipAssociation = new aws.ec2.EipAssociation("eipAssociation", {
  instanceId: ec2Instance.id,
  allocationId: eip.id,
});

// // Create or update the Route53 A Record to point the domain to the EC2 instance's public IP
// const aRecord = new aws.route53.Record(
//   "app-A-record",
//   {
//     zoneId: hostedZoneId,
//     name: domainName,
//     type: "A",
//     ttl: 300,
//     records: [eipAssociation.publicIp],
//   },
//   { provider }
// );

// // Create IAM Policy
// const lbScalingPolicy = new aws.iam.Policy("lbScalingPolicy", {
//   description: "IAM policy for load balancer scaling",
//   policy: JSON.stringify({
//     Version: "2012-10-17",
//     Statement: [
//       {
//         Effect: "Allow",
//         Action: [
//           "elasticloadbalancing:Describe*",
//           "elasticloadbalancing:RegisterTargets",
//           "elasticloadbalancing:DeregisterTargets",
//           "elasticloadbalancing:DescribeTargetHealth",
//         ],
//         Resource: "*",
//       },
//       // Add more specific statements if required
//     ],
//   }),
// });

// // Attach IAM Policy to the Role
// const policyAttachments = new aws.iam.PolicyAttachment(
//   "lbScalingPolicyAttachment",
//   {
//     policyArn: lbScalingPolicy.arn,
//     roles: [ec2Role.name], // Attach to the desired role
//   }
// );

// Your user data script
const userDataScript = pulumi.interpolate`#!/bin/bash
sudo sh -c 'echo "HOST=${rdsInstance.address}" >> /opt/csye6225/webapp/.env'
sudo sh -c 'echo "USER=${rdsInstance.username}" >> /opt/csye6225/webapp/.env'
sudo sh -c 'echo "PASSWORD=${rdsInstance.password}" >> /opt/csye6225/webapp/.env'
sudo sh -c 'echo "DB=${rdsInstance.dbName}" >> /opt/csye6225/webapp/.env'
sudo systemctl daemon-reload
sudo systemctl enable webapp
sudo systemctl start webapp
sudo /opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl \
  -a fetch-config \
  -m ec2 \
  -c file:/opt/aws/amazon-cloudwatch-agent/etc/cloudwatch-config.json \
  -s
  sudo systemctl enable amazon-cloudwatch-agent
  sudo systemctl start amazon-cloudwatch-agent
  sudo systemctl daemon-reload`;
const encodedUserData = userDataScript.apply((data) =>
  Buffer.from(data).toString("base64")
);

// Create Launch Template for Auto Scaling Group
const launchTemplate = new aws.ec2.LaunchTemplate(
  "webAppLaunchTemplate",
  {
    name: "webAppLaunchTemplate",
    description: "Launch template for EC2 instances in the Auto Scaling Group",
    imageId: amiInstance, // Your custom AMI
    instanceType: "t2.micro",
    keyName: keyPem, // Update with your key name
    userData: encodedUserData, // Use existing user data
    networkInterfaces: [
      {
        associatePublicIpAddress: "true",
        securityGroups: [applicationSecurityGroup.id],
      },
    ],
    iamInstanceProfile: {
      arn: ec2InstanceProfile.arn,
    },
  },
  { provider }
);

// Create Target Group
const targetGroup = new aws.lb.TargetGroup("webAppTargetGroup", {
  port: appPort, // Port on which your application listens
  protocol: "HTTP",
  targetType: "instance",
  vpcId: vpc.id,
  healthCheck: {
    enabled: true,
    interval: 60,
    matcher: "200",
    timeout: 30,
    protocol: "HTTP",
    port: "8080", // Health check port
    path: "/healthz", // Health check path
  },
});

// Create Auto Scaling Group
const autoScalingGroup = new aws.autoscaling.Group(
  "webAppAutoScalingGroup",
  {
    defaultCooldown: 60,
    launchTemplate: {
      id: launchTemplate.id,
      version: "$Latest",
    },
    minSize: 1,
    maxSize: 3,
    desiredCapacity: 1,
    vpcZoneIdentifiers: [firstPublicSubnet], // Use public subnets for instances
    tags: [
      {
        key: "AutoScalingGroup",
        value: "TagProperty",
        propagateAtLaunch: true,
      },
      // Add any other necessary tags
    ],
    targetGroupArns: [targetGroup.arn],
  },
  { provider }
);

// Create Auto Scaling Policies
const scaleUpPolicy = new aws.autoscaling.Policy(
  "scaleUpPolicy",
  {
    adjustmentType: "ChangeInCapacity",
    scalingAdjustment: 1,
    cooldown: 60, // Adjust as needed
    autoscalingGroupName: autoScalingGroup.name,
    policyType: "SimpleScaling",
    //estimatedInstanceWarmup: 300,
  },
  { provider }
);

const scaleDownPolicy = new aws.autoscaling.Policy(
  "scaleDownPolicy",
  {
    adjustmentType: "ChangeInCapacity",
    scalingAdjustment: -1,
    cooldown: 60, // Adjust as needed
    autoscalingGroupName: autoScalingGroup.name,
    policyType: "SimpleScaling",
  },
  { provider }
);

// Create CloudWatch alarms to monitor CPU utilization
const cpuAlarmHigh = new aws.cloudwatch.MetricAlarm(
  "cpuAlarmHigh",
  {
    metricName: "CPUUtilization",
    namespace: "AWS/EC2",
    statistic: "Average",
    period: 60,
    evaluationPeriods: 1,
    threshold: 5,
    comparisonOperator: "GreaterThanThreshold",
    alarmActions: [scaleUpPolicy.arn],
    dimensions: {
      AutoScalingGroupName: autoScalingGroup.name,
    },
  },
  { provider }
);

const cpuAlarmLow = new aws.cloudwatch.MetricAlarm(
  "cpuAlarmLow",
  {
    metricName: "CPUUtilization",
    namespace: "AWS/EC2",
    statistic: "Average",
    period: 60,
    evaluationPeriods: 1,
    threshold: 3,
    comparisonOperator: "LessThanThreshold",
    alarmActions: [scaleDownPolicy.arn],
    dimensions: {
      AutoScalingGroupName: autoScalingGroup.name,
    },
  },
  { provider }
);

// Create Application Load Balancer
const loadBalancer = new aws.lb.LoadBalancer("webAppLoadBalancer", {
  internal: false,
  loadBalancerType: "application",
  subnets: publicSubnetIds,
  securityGroups: [loadBalancerSecurityGroup.id], // Use the load balancer security group
  //subnets: [firstPublicSubnet], // Use public subnets for the load balancer
  enableDeletionProtection: false, // Set as needed
});

// Create Listener for ALB
const listener = new aws.lb.Listener("webAppListener", {
  loadBalancerArn: loadBalancer.arn,
  port: 80, // ALB listens on port 80 for incoming HTTP traffic
  protocol: "HTTP",
  defaultActions: [
    {
      type: "forward",
      targetGroupArn: targetGroup.arn,
    },
  ],
});

// // Update Route 53 Record to point to the ALB
// const record = new aws.route53.Record("webAppDnsRecord", {
//   zoneId: hostedZoneId,
//   name: domainName, // Your domain name
//   type: "A",
//   aliases: [
//     {
//       evaluateTargetHealth: true,
//       name: domainName,
//       zoneId: loadBalancer.zoneId,
//     },
//   ],
// });

const aRecord = loadBalancer.dnsName.apply((dnsName) => {
  return new aws.route53.Record("demo.keerthanadevhub.me-A", {
    zoneId: hostedZoneId,
    name: domainName,
    type: "A",
    aliases: [
      {
        name: dnsName,
        zoneId: loadBalancer.zoneId, // Load Balancer Zone ID
        evaluateTargetHealth: true,
      },
    ],
  });
});

const storageServiceAccount = new gcp.serviceaccount.Account(
  "storageServiceAccount",
  {
    accountId: config.require("accountId"),
    displayName: config.require("accountId"),
  }
);

const myServiceAccountKey = new gcp.serviceaccount.Key("myServiceAccountKey", {
  serviceAccountId: storageServiceAccount.accountId,
});
const mysecret = new aws.secretsmanager.Secret("mysecret", {
  name: config.require("mysecret"),
});
new aws.secretsmanager.SecretVersion("my-secret-version", {
  secretBinary: myServiceAccountKey.privateKey,
  secretId: mysecret.id,
});

//     const trackEmailsDynamoDB = new aws.dynamodb.Table("trackEmails", {
//         attributes: [
//             { name: "id", type: "S" },
//         ],
//         hashKey: "id",
//         billingMode: "PAY_PER_REQUEST",
//    });

const trackEmailsDynamoDB = new aws.dynamodb.Table("trackEmails", {
  attributes: [
    { name: "assignmentId", type: "S" },
    { name: "submissionId", type: "S" },
    { name: "userId", type: "S" },
  ],
  hashKey: "assignmentId",
  rangeKey: "submissionId",
  billingMode: "PAY_PER_REQUEST",
  globalSecondaryIndexes: [
    {
      name: "UserIdIndex",
      hashKey: "userId",
      projectionType: "ALL",
    },
  ],
});

const lambdaRole = new aws.iam.Role("lambdaRole", {
  assumeRolePolicy: JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      {
        Action: "sts:AssumeRole",
        Effect: "Allow",
        Principal: {
          Service: "lambda.amazonaws.com",
        },
      },
    ],
  }),
});

new aws.iam.RolePolicyAttachment("lambda-basic-execution-role", {
  role: lambdaRole.name,
  policyArn: config.require("policyArn"),
});

const ec2PolicyForLambda = new aws.iam.RolePolicy("ec2PolicyForLambda", {
  role: lambdaRole.name,
  policy: JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Action: [
          "ec2:CreateNetworkInterface",
          "ec2:DescribeNetworkInterfaces",
          "ec2:DeleteNetworkInterface",
        ],
        Resource: config.require("Resource"),
      },
    ],
  }),
});

const secretsManagerPolicy = new aws.iam.RolePolicy("secretsManagerPolicy", {
  role: lambdaRole.name,
  policy: pulumi
    .output({
      Version: "2012-10-17",
      Statement: [
        {
          Effect: "Allow",
          Action: "secretsmanager:GetSecretValue",
          Resource: mysecret.arn,
        },
      ],
    })
    .apply((policy) => JSON.stringify(policy)),
});

const dynamoDbPolicy = pulumi.interpolate`{
 "Version": "2012-10-17",
 "Statement": [
     {
         "Effect": "Allow",
         "Action": [
             "dynamodb:GetItem",
             "dynamodb:PutItem",
             "dynamodb:UpdateItem"
         ],
         "Resource": "${trackEmailsDynamoDB.arn}"
     }
 ]
}`;

// Attach the policy to the Lambda role
const dynamoDbAccessPolicy = new aws.iam.RolePolicy("dynamoDbAccess", {
  role: lambdaRole.name,
  policy: dynamoDbPolicy,
});

const lambdaSecurityGroup = new aws.ec2.SecurityGroup("lambdaSecurityGroup", {
  vpcId: vpc.id,
  description: "Allow outbound HTTP/S",
  egress: [
    {
      fromPort: 0,
      toPort: 0,
      protocol: "-1", // -1 means all protocols
      cidrBlocks: ["0.0.0.0/0"],
    },
  ],
});

const bucketName = config.require("bucketName");
const bucket = new gcp.storage.Bucket(bucketName, {
  location: "US",
  forceDestroy: true,
  uniformBucketLevelAccess: true,
});
const PROJECT_ID = config.require("project_id");

const lambdaFunction = new aws.lambda.Function("myLambdaFunction", {
  runtime: "nodejs18.x",
  code: new pulumi.asset.AssetArchive({
    ".": new pulumi.asset.FileArchive("./Archive.zip"),
  }),
  handler: "index.handler",
  role: lambdaRole.arn,
  environment: {
    variables: {
      GCP_SECRET_NAME: mysecret.name,
      GCP_BUCKET_NAME: bucket.name,
      DYNAMO_DB_TABLE: trackEmailsDynamoDB.name,
      DOMAIN: process.env.DOMAIN || "",
      API_KEY: process.env.API_KEY || "",
      PROJECT_ID: PROJECT_ID,
    },
  },
});

const lambdaPermission = new aws.lambda.Permission("lambdaPermission", {
  action: "lambda:InvokeFunction",
  function: lambdaFunction.name,
  principal: "sns.amazonaws.com",
  sourceArn: snsTopic.arn,
});

const snsSubscription = new aws.sns.TopicSubscription("snsSubscription", {
  topic: snsTopic.arn,
  protocol: "lambda",
  endpoint: lambdaFunction.arn,
});

async function createGCPServiceAccountAndStoreInAWSSecrets() {
  const projectId = gcp.config.project || "defaultProjectID";
  const iamPolicyBinding = new gcp.projects.IAMBinding("iamPolicyBinding", {
    project: projectId,
    role: "roles/storage.admin",
    members: [
      pulumi.interpolate`serviceAccount:${storageServiceAccount.email}`,
    ],
  });
}

// Export the IDs of the resources created
export const vpcId = vpc.id;

// export const privateSubnetIds = subnets.apply((subnets) =>
//   subnets.filter((_, index) => index % 2 !== 0).map((subnet) => subnet.id)
// );
export const internetGatewayId = internetGateway.id;
export const publicRouteTableId = publicRouteTable.id;
export const privateRouteTableId = privateRouteTable.id;
export const applicationSecurityGroupId = applicationSecurityGroup.id;

export const rdsInstanceId = rdsInstance.id;
export const ec2InstanceId = ec2Instance.id;
export const appUrl = pulumi.interpolate`http://${domainName}:${appPort}/`;
