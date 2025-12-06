from diagrams import Diagram, Cluster, Edge
from diagrams.aws.compute import EC2, Lambda
from diagrams.aws.database import ElastiCache, RDS
from diagrams.aws.integration import MSK, APIGateway
from diagrams.aws.storage import S3
from diagrams.onprem.client import User
from diagrams.programming.language import Cpp

# Diagram Configuration
graph_attr = {
    "fontsize": "20",
    "bgcolor": "white"
}

with Diagram("Liquibook AWS Architecture", show=False, filename="liquibook_aws_architecture", direction="LR", graph_attr=graph_attr):
    client = User("Client App")

    with Cluster("AWS Cloud (Seoul Region)"):
        api_gw = APIGateway("API Gateway\n(WebSocket/REST)")
        
        with Cluster("Serverless Layer"):
            order_router = Lambda("Order Router\n(Go/Rust)")
            stream_handler = Lambda("Stream Handler\n(Node.js)")
            
        with Cluster("Data Streaming"):
            msk = MSK("Amazon MSK\n(Kafka)")
            
        with Cluster("Matching Engine Layer (EC2)"):
            engine = EC2("Liquibook Engine\n(C++)")
            wrapper = Cpp("AWS Wrapper")
            
        with Cluster("Persistence & State"):
            redis = ElastiCache("Redis Cache")
            s3 = S3("Snapshot S3")
            db = RDS("User DB")

        # Connections
        client >> Edge(label="Orders/WS") >> api_gw
        
        api_gw >> Edge(label="Route") >> order_router
        api_gw << Edge(label="Push") << stream_handler
        
        order_router >> Edge(label="Publish Order") >> msk
        order_router >> Edge(label="Check Balance") >> db
        
        msk >> Edge(label="Consume Orders") >> wrapper
        wrapper - Edge(label="Engine Core") - engine
        wrapper >> Edge(label="Publish Fills") >> msk
        
        msk >> Edge(label="Consume Fills") >> stream_handler
        
        wrapper >> Edge(label="Snapshot") >> s3
        wrapper >> Edge(label="State Cache") >> redis
